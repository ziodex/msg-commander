import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	bulkPurgePreviewRequestSchema,
	bulkPurgeRequestSchema,
	type BulkPurgeTarget,
	type BulkPurgePreviewRequest,
	type BulkPurgePlan,
	type BulkPurgeProgress,
} from '../../src/shared/contracts/service-bus/maintenance/index'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
const queue = (
	name: string,
	subQueue: BulkPurgeTarget['subQueue'] = 'active',
): BulkPurgeTarget => ({ target: { kind: 'queue', name }, subQueue })
const sub = (name: string, subQueue: BulkPurgeTarget['subQueue'] = 'active'): BulkPurgeTarget => ({
	target: { kind: 'subscription', topicName: 'order-events', name },
	subQueue,
})
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				service: 'service-bus',
				namespace: 'fixture.servicebus.windows.net',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
}
const previewInput = (
	targets: BulkPurgeTarget[],
	limits: Partial<BulkPurgePreviewRequest> = {},
) => ({ ...request(), targets, maxPerTarget: 100, maxTotal: 100, maxSeconds: 10, ...limits })
const preview = (targets: BulkPurgeTarget[], limits: Partial<BulkPurgePreviewRequest> = {}) =>
	host.request('sb.purge.bulk.preview', previewInput(targets, limits))
const executeInput = (plan: BulkPurgePlan) => ({
	...request(),
	planId: plan.planId,
	confirmation: plan.confirmation,
})
const run = (input: ReturnType<typeof executeInput>, signal?: AbortSignal) =>
	host.request('sb.purge.bulk', input, { signal, waitForCancellation: true, timeout: 20000 })
const peek = (item: BulkPurgeTarget) =>
	host.request('sb.peek', { ...request(), ...item, fromSequenceNumber: '0', maxMessages: 25 })
const send = (item: BulkPurgeTarget, messageId: string, sessionId = '') =>
	host.request('sb.send', {
		...request(),
		target:
			item.target.kind === 'queue'
				? item.target
				: { kind: 'topic', name: item.target.topicName },
		draft: { ...emptyDraft('eA=='), messageId, sessionId },
	})
afterEach(async () => {
	await host?.stop()
})
it('validates the full selection and every budget before creating a review; topics and duplicates are rejected', async () => {
	await start()
	const good = previewInput([queue('orders')])
	for (const input of [
		{ ...good, targets: [] },
		{ ...good, targets: Array.from({ length: 101 }, (_, i) => queue(`q${i}`)) },
		{ ...good, targets: [queue('orders'), queue('ORDERS')] },
		{ ...good, targets: [queue('évents'), queue('ÉVENTS')] },
		{
			...good,
			targets: [{ target: { kind: 'topic', name: 'order-events' }, subQueue: 'active' }],
		},
		{ ...good, targets: [queue('orders', 'invalid' as never)] },
		{ ...good, maxTotal: 0 },
		{ ...good, maxPerTarget: 100001 },
		{ ...good, maxSeconds: 601 },
	]) {
		expect(bulkPurgePreviewRequestSchema.safeParse(input).success).toBe(false)
		await expect(host.request('sb.purge.bulk.preview', input as never)).rejects.toThrow()
	}
	await expect(preview([queue('orders'), queue('deleted')])).rejects.toThrow()
	expect((await peek(queue('orders'))).items).toHaveLength(2)
})
it('binds confirmation to an immutable one-use review; receipts cannot run twice or cross connections', async () => {
	await start()
	const plan = await preview([queue('orders')], { maxPerTarget: 1 })
	const input = executeInput(plan)
	expect(bulkPurgeRequestSchema.safeParse({ ...input, targets: [queue('empty')] }).success).toBe(
		false,
	)
	await expect(run({ ...input, confirmation: 'PURGE' })).rejects.toThrow('Confirm')
	expect((await peek(queue('orders'))).items).toHaveLength(2)
	const result = await run(input)
	expect(result).toMatchObject({
		completed: 1,
		status: 'limited',
		reason: 'target-limits',
		plan: { items: [{ target: queue('orders').target, subQueue: 'active' }] },
	})
	expect(await run(input)).toEqual(result)
	await expect(run({ ...input, confirmation: 'different' })).rejects.toThrow('different request')
	await expect(run({ ...input, id: randomUUID() })).rejects.toThrow('already used')
	expect((await peek(queue('orders'))).items).toHaveLength(1)
	expect(
		await host.request('sb.purge.bulk.result', { ...request(), operationId: input.id }),
	).toEqual(result)
	await host.request('sb.disconnect', { connectionId })
	await expect(
		host.request('sb.purge.bulk.result', { ...request(), operationId: input.id }),
	).rejects.toThrow('Connection expired')
})
it('visits selected queues and subscriptions with independent main/DLQ/transfer subqueues and per-target results', async () => {
	await start()
	const items = [
		queue('orders'),
		sub('billing', 'dead-letter'),
		queue('orders', 'transfer-dead-letter'),
	]
	const plan = await preview(items),
		input = executeInput(plan),
		events: BulkPurgeProgress[] = []
	host.on('event', (event) => {
		if (event.type === 'bulk-purge-progress') events.push(event)
	})
	const result = await run(input)
	expect(result).toMatchObject({
		status: 'completed',
		reason: 'targets-finished',
		completed: 4,
		received: 4,
		uncertain: 0,
	})
	expect(result.items.map((item) => item.result?.completed)).toEqual([2, 1, 1])
	expect(result.summary).toContain('does not prove')
	expect((await peek(queue('orders', 'dead-letter'))).items).toHaveLength(1)
	expect((await peek(sub('audit', 'dead-letter'))).items).toHaveLength(1)
	expect(events.at(-1)).toMatchObject({
		phase: 'finished',
		activeIndex: null,
		completed: 4,
		current: null,
	})
	expect(
		events.every(
			(event, index) =>
				event.completed <= event.received &&
				(!index || event.completed >= events[index - 1].completed),
		),
	).toBe(true)
})
it('continues after a per-target cap but stops at the global cap with later targets explicitly unstarted', async () => {
	await start()
	const plan = await preview([queue('orders'), queue('other'), queue('last')], {
		maxPerTarget: 1,
		maxTotal: 2,
	})
	const result = await run(executeInput(plan))
	expect(result).toMatchObject({ status: 'limited', reason: 'total-limit', completed: 2 })
	expect(result.items.map((item) => item.result?.completed ?? null)).toEqual([1, 1, null])
	expect((await peek(queue('last'))).items).toHaveLength(2)
})
it('cancels between targets, preserving acknowledged counts and leaving the next target untouched', async () => {
	await start()
	const plan = await preview([queue('orders'), queue('next')]),
		input = executeInput(plan),
		controller = new AbortController()
	host.on('event', (event) => {
		if (
			event.type === 'bulk-purge-progress' &&
			event.items[0].result &&
			event.activeIndex === null
		)
			controller.abort()
	})
	// Gate the next receive too: IPC cancellation can race the boundary event.
	await send(queue('next'), 'purge-wait-receive')
	const result = await run(input, controller.signal)
	expect(result).toMatchObject({ status: 'cancelled', completed: 2, uncertain: 0 })
	expect((await peek(queue('next'))).items.map((m) => m.messageId)).toEqual([
		'purge-wait-receive',
	])
	expect(
		await host.request('sb.purge.bulk.result', { ...request(), operationId: input.id }),
	).toEqual(result)
})
it('enforces a whole-job deadline and never visits subsequent targets after it', async () => {
	await start()
	await send(queue('slow-target'), 'purge-wait-receive')
	const result = await run(
		executeInput(
			await preview([queue('orders'), queue('slow-target'), queue('last')], {
				maxSeconds: 1,
			}),
		),
	)
	expect(result).toMatchObject({ status: 'limited', reason: 'time-limit', completed: 2 })
	expect(result.items[1].result).toMatchObject({
		status: 'limited',
		reason: 'time-limit',
		completed: 0,
	})
	expect(result.items[2].result).toBeNull()
})
it('stops at a known rejection and retains all later targets without retry', async () => {
	await start()
	const result = await run(
		executeInput(await preview([queue('orders'), queue('purge-denied'), queue('next')])),
	)
	expect(result).toMatchObject({
		status: 'failed',
		reason: 'target-error',
		completed: 2,
		uncertain: 0,
	})
	expect(result.items[1].result?.status).toBe('failed')
	expect(result.items[2].result).toBeNull()
	expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('stops on an uncertain completion, recovers the same receipt and cannot repeat the review', async () => {
	await start()
	await send(queue('uncertain'), 'unknown-complete')
	const input = executeInput(await preview([queue('orders'), queue('uncertain'), queue('next')]))
	const result = await run(input)
	expect(result).toMatchObject({ status: 'unknown', received: 3, completed: 2, uncertain: 1 })
	expect(result.items[2].result).toBeNull()
	expect(await run(input)).toEqual(result)
	expect((await peek(queue('uncertain'))).items).toHaveLength(0)
	expect((await peek(queue('next'))).items).toHaveLength(2)
})
it('stops after uncertain cleanup before opening another receiver', async () => {
	await start()
	const result = await run(
		executeInput(await preview([queue('purge-cleanup-fail'), queue('next')])),
	)
	expect(result).toMatchObject({
		status: 'failed',
		reason: 'cleanup-error',
		completed: 2,
		uncertain: 0,
	})
	expect(result.items[0].result?.cleanupWarning).toContain('cleanup')
	expect(result.items[1].result).toBeNull()
})
it('handles available sessions and dead-letter subqueues without touching held sessions or session state', async () => {
	await start()
	await send(queue('sessions'), 's1', 'one')
	await send(queue('sessions'), 's2', 'two')
	await send(queue('sessions'), 'locked', 'locked-session')
	const result = await run(
		executeInput(await preview([queue('sessions'), sub('audit', 'dead-letter')])),
	)
	expect(result.completed).toBe(3)
	expect((await peek(queue('sessions'))).items.map((m) => m.sessionId)).toEqual([
		'locked-session',
	])
	const accepted = await host.request('sb.session.accept', {
		...request(),
		target: queue('sessions').target,
		sessionId: 'state-only',
	})
	expect(
		(
			await host.request('sb.session.state', {
				...request(),
				leaseId: accepted.session!.leaseId,
			})
		).isSet,
	).toBe(true)
	await expect(preview([queue('orders')])).rejects.toThrow('Close the current')
})
it('rechecks receiver ownership after review and forbids bulk work while a listener is active', async () => {
	await start()
	const plan = await preview([queue('orders')])
	await host.request('sb.receive', {
		...request(),
		...queue('orders'),
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(run(executeInput(plan))).rejects.toThrow('Close the current')
	await host.request('sb.close-receiver', request())
	const listener = await host.request('sb.listener.start', {
		...request(),
		target: queue('empty').target,
		sessionId: '',
		mode: 'manual',
		maxMessages: 10,
		maxSeconds: 60,
		maxLockSeconds: 60,
	})
	await expect(preview([queue('orders')])).rejects.toThrow('Stop the listener')
	await expect(run(executeInput(plan))).rejects.toThrow('Stop the listener')
	await host.request('sb.listener.stop', { ...request(), listenerId: listener.listenerId })
})
it('recovers a final receipt after transport timeout without restarting later targets', async () => {
	await start()
	await send(queue('late'), 'purge-commit-late')
	const input = executeInput(await preview([queue('late'), queue('next')], { maxPerTarget: 1 }))
	await expect(
		host.request('sb.purge.bulk', input, { timeout: 80, waitForCancellation: true }),
	).rejects.toMatchObject({ code: 'TIMEOUT' })
	const result = await host.request('sb.purge.bulk.result', {
		...request(),
		operationId: input.id,
	})
	expect(result).toMatchObject({ completed: 1, uncertain: 0, status: 'cancelled' })
	expect(result!.items[1].result).toBeNull()
	expect(await run(input)).toEqual(result)
})

it('keeps a cancelled in-flight completion uncertain but counts an acknowledgement that wins cancellation', async () => {
	await start()
	for (const messageId of ['purge-wait-complete', 'purge-commit-late']) {
		const source = queue(messageId)
		await send(source, messageId)
		const input = executeInput(await preview([source, queue('next')], { maxPerTarget: 1 }))
		const controller = new AbortController()
		const listener = (event: BulkPurgeProgress) => {
			if (
				event.type === 'bulk-purge-progress' &&
				event.operationId === input.id &&
				event.current?.phase === 'completing'
			)
				setTimeout(() => controller.abort(), 50)
		}
		host.on('event', listener)
		const result = await run(input, controller.signal)
		host.off('event', listener)
		expect(result.status).toBe(messageId === 'purge-wait-complete' ? 'unknown' : 'cancelled')
		expect(result.completed).toBe(messageId === 'purge-wait-complete' ? 0 : 1)
		expect(result.uncertain).toBe(messageId === 'purge-wait-complete' ? 1 : 0)
		expect(result.items[1].result).toBeNull()
	}
})
it('cancels during the first target receive without deletions and retains the cancelled receipt', async () => {
	await start()
	const input = executeInput(await preview([queue('orders'), queue('next')]))
	const controller = new AbortController()
	host.on('event', (event) => {
		if (event.type === 'bulk-purge-progress' && event.current?.phase === 'opening')
			controller.abort()
	})
	// Cancellation forwarding can race fast fixtures; a receive wait makes the broker boundary deterministic.
	await send(queue('orders'), 'purge-wait-receive')
	const result = await run(input, controller.signal)
	expect(result).toMatchObject({ status: 'cancelled', completed: 0, uncertain: 0 })
	expect(result.items[1].result).toBeNull()
	expect((await peek(queue('orders'))).items.map((m) => m.messageId)).toEqual([
		'purge-wait-receive',
	])
})
