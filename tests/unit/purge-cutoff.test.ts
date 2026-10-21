import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	purgeConfirmation,
	purgeRequestSchema,
	type PurgeRequest,
	type PurgeProgress,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import {
	bulkPurgePreviewRequestSchema,
	bulkPurgeRequestSchema,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import { emptyPurgeCutoff, selectedPurgeCutoff } from '../../src/shared/purge-cutoff'
import type { PeekTarget, MessageSubQueue } from '../../src/shared/service-bus'
const namespace = 'fixture.servicebus.windows.net',
	cutoff = '2025-01-01T12:00:00.000Z'
const old = '2025-01-01T11:59:59.999Z',
	newer = '2025-01-01T12:00:00.001Z'
const target: PeekTarget = { kind: 'queue', name: 'empty' }
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
async function start() {
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				namespace,
				service: 'service-bus',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
}
function input(
	destination: PeekTarget = target,
	subQueue: MessageSubQueue = 'active',
	before = cutoff,
): PurgeRequest {
	return {
		...request(),
		target: destination,
		subQueue,
		maxMessages: 1000,
		maxSeconds: 10,
		beforeEnqueueTime: before,
		confirmation: purgeConfirmation(namespace, destination, subQueue, before),
	}
}
const purge = (value = input(), signal?: AbortSignal) =>
	host.request('sb.purge', value, { signal, waitForCancellation: true, timeout: 20000 })
const peek = (destination: PeekTarget = target, subQueue: MessageSubQueue = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: destination,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
const send = (
	messageId: string,
	timestamp = old,
	destination: PeekTarget = target,
	subQueue: MessageSubQueue | 'deferred' | 'scheduled' = 'active',
	sessionId = '',
) =>
	host.request('sb.send', {
		...request(),
		target:
			destination.kind === 'queue'
				? destination
				: { kind: 'topic', name: destination.topicName },
		draft: {
			...emptyDraft('eA=='),
			messageId,
			sessionId,
			properties: [
				{ name: 'fixture-enqueued-time', type: 'string', value: timestamp },
				{ name: 'fixture-subqueue', type: 'string', value: subQueue },
			],
		},
	})
const preview = (
	targets: { target: PeekTarget; subQueue: MessageSubQueue }[] = [{ target, subQueue: 'active' }],
) =>
	host.request('sb.purge.bulk.preview', {
		...request(),
		targets,
		maxPerTarget: 1000,
		maxTotal: 1000,
		maxSeconds: 10,
		beforeEnqueueTime: cutoff,
	})
afterEach(async () => {
	await host?.stop()
})

it('validates explicit canonical UTC cutoff at both boundaries and binds single confirmation to it', async () => {
	await start()
	await send('untouched')
	const good = input()
	for (const bad of [
		'',
		null,
		0,
		'2025-01-01',
		'2025-01-01T12:00:00',
		'2025-01-01T12:00:00.000+00:00',
		'2025-02-30T12:00:00.000Z',
		'0000-01-01T12:00:00.000Z',
		'2025-01-01T12:00:00Z',
	]) {
		const value = { ...good, beforeEnqueueTime: bad }
		expect(purgeRequestSchema.safeParse(value).success).toBe(false)
		await expect(purge(value as never)).rejects.toThrow('UTC purge cutoff')
		const bulk = {
			...request(),
			targets: [{ target, subQueue: 'active' }],
			maxPerTarget: 10,
			maxTotal: 10,
			maxSeconds: 10,
			beforeEnqueueTime: bad,
		}
		expect(bulkPurgePreviewRequestSchema.safeParse(bulk).success).toBe(false)
		await expect(host.request('sb.purge.bulk.preview', bulk as never)).rejects.toThrow(
			'UTC purge cutoff',
		)
	}
	await expect(
		purge({ ...good, confirmation: purgeConfirmation(namespace, target, 'active') }),
	).rejects.toThrow('Confirm')
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['untouched'])
})
it('deletes only strictly older messages, including older messages behind newer ones and sub-millisecond boundaries', async () => {
	await start()
	for (const [id, time] of [
		['old', old],
		['equal', cutoff],
		['new', newer],
		['old-behind-new', '2020-01-01T00:00:00.000Z'],
		['one-tick-before', '2025-01-01T11:59:59.9999999Z'],
		['one-tick-after', '2025-01-01T12:00:00.0000001Z'],
	])
		await send(id, time)
	const events: PurgeProgress[] = []
	host.on('event', (e) => {
		if (e.type === 'purge-progress') events.push(e)
	})
	const value = input(),
		result = await purge(value)
	expect(result).toMatchObject({
		status: 'completed',
		completed: 3,
		received: 6,
		skipped: 3,
		uncertain: 0,
		beforeEnqueueTime: cutoff,
	})
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['equal', 'new', 'one-tick-after'])
	expect((await peek()).items.every((m) => m.state === 'Active')).toBe(true)
	expect(events.at(-1)).toMatchObject({
		phase: 'finished',
		completed: 3,
		skipped: 3,
		beforeEnqueueTime: cutoff,
	})
	expect(await purge(value)).toEqual(result)
	await expect(purge({ ...value, beforeEnqueueTime: newer })).rejects.toThrow('different request')
	expect(await host.request('sb.purge.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
})
it('uses original enqueue time for queue/subscription DLQ and transfer DLQ without touching other subqueues', async () => {
	await start()
	for (const destination of [
		target,
		{ kind: 'subscription', topicName: 'order-events', name: 'billing' } as const,
	]) {
		for (const scope of ['active', 'dead-letter', 'transfer-dead-letter'] as const) {
			await send(`${scope}-new`, newer, destination, scope)
			await send(`${scope}-old`, old, destination, scope)
		}
		for (const scope of ['dead-letter', 'transfer-dead-letter'] as const) {
			const result = await purge(input(destination, scope))
			expect(result).toMatchObject({ completed: 1, uncertain: 0, beforeEnqueueTime: cutoff })
			expect((await peek(destination, scope)).items.map((m) => m.messageId)).toContain(
				`${scope}-new`,
			)
			expect((await peek(destination, scope)).items.map((m) => m.messageId)).not.toContain(
				`${scope}-old`,
			)
		}
		expect((await peek(destination)).items).toHaveLength(2)
	}
})
it('stops at retention bound, keeps exact/newer messages and reports older work left behind', async () => {
	await start()
	await send('old-first')
	for (let i = 0; i < 101; i++) await send(`retained-${i}`, newer)
	await send('old-after-limit')
	const result = await purge()
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'retention-limit',
		completed: 1,
		received: 101,
		skipped: 100,
		uncertain: 0,
	})
	expect(result.summary).toContain('Older messages may remain')
	const remaining = await peek()
	expect(remaining.items).toHaveLength(25)
	expect(remaining.items.every((m) => m.messageId?.startsWith('retained-'))).toBe(true)
	const all = [...remaining.items]
	let cursor = remaining.nextSequenceNumber
	for (let pageIndex = 0; cursor && pageIndex < 5; pageIndex++) {
		const page = await host.request('sb.peek', {
			...request(),
			target,
			subQueue: 'active',
			fromSequenceNumber: cursor,
			maxMessages: 25,
		})
		all.push(...page.items)
		cursor = page.nextSequenceNumber
		if (page.items.length < 25) break
	}
	expect(all).toHaveLength(102)
	expect(all.at(-1)?.messageId).toBe('old-after-limit')
})
it('stops on retained-message redelivery without abandoning, deferring or deleting it', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'cutoff-redelivery' }
	await send('new', newer, destination)
	await send('old-later', old, destination)
	expect(await purge(input(destination))).toMatchObject({
		status: 'limited',
		reason: 'redelivery',
		received: 2,
		completed: 0,
		skipped: 1,
	})
	expect((await peek(destination)).items.map((m) => m.messageId)).toEqual(['new', 'old-later'])
})
it('caps confirmed deletions independently of skipped messages and preserves scheduled/deferred deliveries', async () => {
	await start()
	await send('new', newer)
	await send('old')
	await send('old-later')
	await send('deferred', old, target, 'deferred')
	await send('scheduled', old, target, 'scheduled')
	expect(await purge({ ...input(), maxMessages: 1 })).toMatchObject({
		reason: 'message-limit',
		received: 2,
		completed: 1,
		skipped: 1,
	})
	expect((await peek()).items.map((m) => m.messageId)).toEqual([
		'new',
		'old-later',
		'deferred',
		'scheduled',
	])
})
it('fails closed when the broker enqueue time is unavailable', async () => {
	await start()
	await send('unknown-time', '0001-01-01T00:00:00.000Z')
	expect(await purge()).toMatchObject({
		status: 'failed',
		completed: 0,
		skipped: 0,
		uncertain: 0,
	})
	expect((await peek()).items).toHaveLength(1)
})
it('does not loop on a session with retained messages, and preserves session state', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'sessions' }
	await send('old-first', old, destination, 'active', 'one')
	await send('new-one', newer, destination, 'active', 'one')
	await send('old-after-new', old, destination, 'active', 'one')
	await send('other-session', old, destination, 'active', 'two')
	expect(await purge(input(destination))).toMatchObject({
		status: 'limited',
		reason: 'session-revisited',
		completed: 2,
		skipped: 1,
	})
	expect((await peek(destination)).items.map((m) => m.messageId)).toEqual([
		'new-one',
		'other-session',
	])
	const accepted = await host.request('sb.session.accept', {
		...request(),
		target: destination,
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
})
it('cancels after retaining a newer message before deleting a later old one', async () => {
	await start()
	await send('new', newer)
	await send('purge-wait-receive')
	const controller = new AbortController(),
		value = input()
	host.on('event', (e) => {
		if (e.type === 'purge-progress' && e.operationId === value.id && e.phase === 'retaining')
			controller.abort()
	})
	expect(await purge(value, controller.signal)).toMatchObject({
		status: 'cancelled',
		completed: 0,
		skipped: 1,
		uncertain: 0,
	})
	expect((await peek()).items).toHaveLength(2)
})
it('retains skipped counts and cutoff across deadlines and uncertain or rejected completion', async () => {
	await start()
	for (const [id, status, uncertain] of [
		['purge-wait-receive', 'limited', 0],
		['unknown-complete', 'unknown', 1],
		['purge-reject-complete', 'failed', 0],
	] as const) {
		const destination: PeekTarget = { kind: 'queue', name: id }
		await send('new', newer, destination)
		await send(id, old, destination)
		const result = await purge({ ...input(destination), maxSeconds: 1 })
		expect(result).toMatchObject({
			status,
			uncertain,
			skipped: 1,
			completed: 0,
			beforeEnqueueTime: cutoff,
		})
		expect(JSON.stringify(result)).not.toContain('SECRET')
	}
})
it('retains late completion acknowledgements during cancellation with the cutoff still applied', async () => {
	await start()
	await send('purge-commit-late')
	const value = { ...input(), maxMessages: 1 },
		controller = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'purge-progress' && e.operationId === value.id && e.phase === 'completing')
			setTimeout(() => controller.abort(), 50)
	})
	expect(await purge(value, controller.signal)).toMatchObject({
		status: 'limited',
		completed: 1,
		uncertain: 0,
		beforeEnqueueTime: cutoff,
	})
})
it('binds bulk cutoff to the immutable review and retains per-target/aggregate skipped results', async () => {
	await start()
	const second: PeekTarget = { kind: 'subscription', name: 'billing', topicName: 'order-events' }
	for (const destination of [target, second]) {
		await send('new', newer, destination, 'dead-letter')
		await send('old', old, destination, 'dead-letter')
	}
	const targets = [target, second].map((target) => ({ target, subQueue: 'dead-letter' as const }))
	const plan = await preview(targets)
	expect(plan.beforeEnqueueTime).toBe(cutoff)
	expect(plan.confirmation).toContain(` BEFORE ${cutoff}`)
	const value = { ...request(), planId: plan.planId, confirmation: plan.confirmation }
	expect(bulkPurgeRequestSchema.safeParse({ ...value, beforeEnqueueTime: newer }).success).toBe(
		false,
	)
	await expect(
		host.request('sb.purge.bulk', { ...value, beforeEnqueueTime: newer } as never),
	).rejects.toThrow('Review the cutoff')
	await expect(
		host.request('sb.purge.bulk', { ...value, confirmation: `PURGE ${namespace} 2 TARGETS` }),
	).rejects.toThrow('Confirm')
	const result = await host.request('sb.purge.bulk', value)
	expect(result).toMatchObject({
		status: 'completed',
		received: 4,
		completed: 2,
		skipped: 2,
		plan: { beforeEnqueueTime: cutoff },
	})
	expect(
		result.items.every(
			(item) => item.result?.skipped === 1 && item.result.beforeEnqueueTime === cutoff,
		),
	).toBe(true)
	expect(await host.request('sb.purge.bulk', value)).toEqual(result)
})
it('continues bulk jobs after a scan boundary without spending the deletion budget on retained messages', async () => {
	await start()
	const repeated: PeekTarget = { kind: 'queue', name: 'cutoff-redelivery' }
	await send('new', newer, repeated)
	await send('old', old, target)
	const plan = await preview([repeated, target].map((target) => ({ target, subQueue: 'active' })))
	const result = await host.request('sb.purge.bulk', {
		...request(),
		planId: plan.planId,
		confirmation: plan.confirmation,
	})
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'target-limits',
		completed: 1,
		skipped: 1,
	})
	expect(result.items[0].result?.reason).toBe('redelivery')
	expect(result.items[1].result?.completed).toBe(1)
})
it('keeps cutoff optional and unchanged all-age behavior', async () => {
	await start()
	await send('new', newer)
	await send('old')
	const { beforeEnqueueTime: _, ...value } = input()
	expect(
		await purge({ ...value, confirmation: purgeConfirmation(namespace, target, 'active') }),
	).toMatchObject({ completed: 2, skipped: 0, beforeEnqueueTime: null })
})
it('converts local/UTC input explicitly, rejects invalid calendar dates and DST gaps/folds', () => {
	const previous = process.env.TZ
	try {
		process.env.TZ = 'Europe/Madrid'
		expect(selectedPurgeCutoff(emptyPurgeCutoff())).toBeUndefined()
		const local = { enabled: true, zone: 'local' as const, dateTime: '2025-01-01T13:00:00' }
		expect(selectedPurgeCutoff(local)).toBe(cutoff)
		expect(selectedPurgeCutoff({ ...local, zone: 'utc' })).toBe('2025-01-01T13:00:00.000Z')
		for (const dateTime of [
			'',
			'2025-02-30T12:00',
			'2025-03-30T02:30',
			'2025-10-26T02:30',
			'0000-01-01T00:00',
		])
			expect(selectedPurgeCutoff({ ...local, dateTime })).toBeNull()
		expect(selectedPurgeCutoff({ ...local, zone: 'utc', dateTime: '2025-10-26T02:30' })).toBe(
			'2025-10-26T02:30:00.000Z',
		)
	} finally {
		if (previous === undefined) delete process.env.TZ
		else process.env.TZ = previous
	}
})
it('retains cutoff progress on bulk cancellation and leaves later targets unstarted', async () => {
	await start()
	await send('new', newer)
	await send('purge-wait-receive')
	const plan = await preview([
		{ target, subQueue: 'active' },
		{ target: { kind: 'queue', name: 'orders' }, subQueue: 'dead-letter' },
	])
	const value = { ...request(), planId: plan.planId, confirmation: plan.confirmation },
		controller = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'bulk-purge-progress' &&
			e.operationId === value.id &&
			e.current?.phase === 'retaining'
		)
			controller.abort()
	})
	const result = await host.request('sb.purge.bulk', value, {
		signal: controller.signal,
		waitForCancellation: true,
	})
	expect(result).toMatchObject({
		status: 'cancelled',
		completed: 0,
		skipped: 1,
		uncertain: 0,
		plan: { beforeEnqueueTime: cutoff },
	})
	expect(result.items[0].result?.skipped).toBe(1)
	expect(result.items[1].result).toBeNull()
})
it('reports cutoff cleanup failures without losing counts and stops subsequent bulk targets', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'purge-cleanup-fail' }
	await send('new', newer, destination)
	await send('old', old, destination)
	const plan = await preview([
		{ target: destination, subQueue: 'active' },
		{ target, subQueue: 'active' },
	])
	const result = await host.request('sb.purge.bulk', {
		...request(),
		planId: plan.planId,
		confirmation: plan.confirmation,
	})
	expect(result).toMatchObject({
		status: 'failed',
		reason: 'cleanup-error',
		completed: 1,
		skipped: 1,
		uncertain: 0,
	})
	expect(result.items[0].result?.cleanupWarning).toContain('cleanup')
	expect(result.items[1].result).toBeNull()
})
