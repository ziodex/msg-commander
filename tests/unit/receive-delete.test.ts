import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	receiveDeleteConfirmation,
	receiveDeleteRequestSchema,
	type ReceiveDeleteRequest,
	type ReceiveDeleteProgress,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import type { PeekTarget, MessageSubQueue } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const target: PeekTarget = { kind: 'queue', name: 'orders' }
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
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
function input(
	destination: PeekTarget = target,
	subQueue: MessageSubQueue = 'active',
	sessionId = '',
): ReceiveDeleteRequest {
	return {
		...request(),
		target: destination,
		subQueue,
		sessionId,
		confirmation: receiveDeleteConfirmation(
			'fixture.servicebus.windows.net',
			destination,
			subQueue,
			sessionId,
		),
		maxMessages: 100,
		maxSeconds: 10,
	}
}
const consume = (value = input(), signal?: AbortSignal) =>
	host.request('sb.receive-delete', value, { signal, waitForCancellation: true, timeout: 20000 })
const send = (messageId: string, destination: PeekTarget = target, sessionId = '') =>
	host.request('sb.send', {
		...request(),
		target:
			destination.kind === 'subscription'
				? { kind: 'topic', name: destination.topicName }
				: destination,
		draft: { ...emptyDraft('AP9B'), messageId, sessionId },
	})
const peek = (destination: PeekTarget = target, subQueue: MessageSubQueue = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: destination,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
afterEach(async () => {
	await host?.stop()
})
it('routes SDK ReceiveAndDelete without prefetch/settlement and disposes dedicated clients', () => {
	expect(
		execFileSync('dotnet', [dll, '--receive-delete-checks'], { encoding: 'utf8' }),
	).toContain('Receive-and-delete adapter checks passed')
})
it('validates exact source/session confirmation and both bounds before consumption', async () => {
	await start()
	const value = input()
	for (const bad of [
		{ ...value, confirmation: 'DELETE' },
		{ ...value, subQueue: 'dead-letter' as const },
		{ ...value, maxMessages: 0 },
		{ ...value, maxMessages: 101 },
		{ ...value, maxSeconds: 0 },
		{ ...value, maxSeconds: 601 },
		{ ...value, target: { kind: 'topic', name: 'orders' } as never },
		input(target, 'dead-letter', 'one'),
	])
		await expect(consume(bad)).rejects.toThrow()
	expect(receiveDeleteRequestSchema.safeParse({ ...value, extra: true }).success).toBe(false)
	expect((await consume()).received).toBe(2)
})
it('consumes to count cap, retains inspectable bytes across peeks, and never creates held deliveries', async () => {
	await start()
	const value = { ...input(), maxMessages: 1 },
		events: ReceiveDeleteProgress[] = []
	host.on('event', (e) => {
		if (e.type === 'receive-delete-progress') events.push(e)
	})
	const result = await consume(value)
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'message-limit',
		received: 1,
		uncertain: false,
	})
	expect(await consume(value)).toEqual(result)
	await expect(consume({ ...value, maxMessages: 2 })).rejects.toThrow('different request')
	expect(
		await host.request('sb.receive-delete.result', { ...request(), operationId: value.id }),
	).toEqual(result)
	expect((await peek()).items).toHaveLength(1)
	const snapshotId = result.items[0].snapshotId!
	const details = await host.request('sb.inspect', { ...request(), snapshotId })
	expect(details.applicationProperties).toContainEqual({
		name: 'exact',
		type: 'int64',
		value: '9223372036854775807',
	})
	expect(
		(await host.request('sb.body', { ...request(), snapshotId, offset: 0, count: 100 })).base64,
	).toBe('AP9B')
	expect((await host.request('sb.deliveries', request())).items).toEqual([])
	expect(events.at(-1)).toMatchObject({ phase: 'finished', received: 1 })
	expect(events.every((e) => !JSON.stringify(e).includes('received-001'))).toBe(true)
	await consume()
	await expect(host.request('sb.inspect', { ...request(), snapshotId })).rejects.toThrow(
		'Consumed messages cannot be fetched again',
	)
})
it('keeps main, ordinary DLQ and transfer DLQ isolated for queues and subscriptions', async () => {
	await start()
	for (const destination of [
		target,
		{ kind: 'subscription', name: 'billing', topicName: 'order-events' } as const,
	]) {
		expect((await consume(input(destination, 'dead-letter'))).received).toBe(1)
		expect((await peek(destination)).items).toHaveLength(2)
		expect((await consume(input(destination, 'transfer-dead-letter'))).received).toBe(1)
		expect((await peek(destination, 'dead-letter')).items).toHaveLength(0)
		expect((await consume(input(destination))).received).toBe(2)
	}
	expect(
		(
			await consume(
				input({ kind: 'subscription', name: 'billing', topicName: 'different-topic' }),
			)
		).received,
	).toBe(2)
})
it('uses explicit sessions, preserves session state, and refuses missing/mismatched session IDs', async () => {
	await start()
	const sessions: PeekTarget = { kind: 'queue', name: 'sessions' }
	expect((await consume(input(sessions))).summary).toContain('Enter a session ID')
	await send('one', sessions, 'one')
	await send('two', sessions, 'two')
	expect((await consume(input(sessions, 'active', 'one'))).received).toBe(1)
	expect((await peek(sessions)).items.map((m) => m.sessionId)).toContain('two')
	expect((await consume(input(target, 'active', 'invalid'))).status).toBe('failed')
	const held = await host.request('sb.session.accept', {
		...request(),
		target: sessions,
		sessionId: 'state-only',
	})
	expect(
		(await host.request('sb.session.state', { ...request(), leaseId: held.session!.leaseId }))
			.isSet,
	).toBe(true)
	await expect(consume()).rejects.toThrow('Close the current')
})
it('protects an existing PeekLock receiver and does not settle its messages', async () => {
	await start()
	const held = await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(consume()).rejects.toThrow('Close the current')
	expect((await host.request('sb.deliveries', request())).items[0].state).toBe('active')
	expect(
		(
			await host.request('sb.settle', {
				...request(),
				deliveryId: held.items[0].deliveryId,
				action: 'abandon',
				reason: '',
				description: '',
			})
		).status,
	).toBe('confirmed')
})
it('stops on idle without claiming empty and leaves deferred and scheduled messages', async () => {
	await start()
	const held = await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await host.request('sb.settle', {
		...request(),
		deliveryId: held.items[0].deliveryId,
		action: 'defer',
		reason: '',
		description: '',
	})
	await host.request('sb.close-receiver', request())
	await host.request('sb.send.batch', {
		...request(),
		target,
		drafts: [{ ...emptyDraft('eA=='), messageId: 'scheduled' }],
		scheduledEnqueueTime: new Date(Date.now() + 3600000).toISOString(),
	})
	const result = await consume()
	expect(result).toMatchObject({ received: 1, reason: 'no-available-messages' })
	expect(result.summary).toContain('not guaranteed empty')
	expect((await peek()).items.map((m) => m.state).sort()).toEqual(['Deferred', 'Scheduled'])
})
it('enforces time budget during opening without consuming anything', async () => {
	await start()
	const result = await consume({
		...input({ kind: 'queue', name: 'consume-open-slow' }),
		maxSeconds: 1,
	})
	expect(result).toMatchObject({
		received: 0,
		status: 'limited',
		reason: 'time-limit',
		uncertain: false,
	})
	expect(result.elapsedMs).toBeLessThan(3000)
})
it('reports a time-limited in-flight receive as uncertain with no retry', async () => {
	await start()
	const result = await consume({
		...input({ kind: 'queue', name: 'consume-receive-slow' }),
		maxSeconds: 1,
	})
	expect(result).toMatchObject({ received: 0, status: 'unknown', uncertain: true })
	expect(result.summary).toContain('may have consumed')
})
it('keeps returned messages when cancellation races a completed transfer', async () => {
	await start()
	await send('consume-return-late')
	const abort = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'receive-delete-progress' && e.phase === 'receiving')
			setTimeout(() => abort.abort(), 40)
	})
	const result = await consume(input(), abort.signal)
	expect(result).toMatchObject({ received: 1, status: 'cancelled', uncertain: false })
	expect(result.items[0].snapshotId).not.toBeNull()
	expect((await peek()).items).toHaveLength(0)
})
it('reports lost transfers conservatively, sanitizes errors, and retains an idempotent receipt', async () => {
	await start()
	await send('first')
	await send('consume-unknown')
	await send('last')
	const value = input(),
		result = await consume(value)
	expect(result).toMatchObject({ received: 1, status: 'unknown', uncertain: true })
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(await consume(value)).toEqual(result)
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['last'])
})
it('cancellation after deletion without a returned message is uncertain', async () => {
	await start()
	await send('consume-cancel-after-delete')
	const abort = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'receive-delete-progress' && e.phase === 'receiving')
			setTimeout(() => abort.abort(), 50)
	})
	const result = await consume(input(), abort.signal)
	expect(result).toMatchObject({ received: 0, status: 'unknown', uncertain: true })
	expect((await peek()).items).toHaveLength(0)
})
it('stops after an oversized consumed body and does not consume the next message', async () => {
	await start()
	await send('consume-oversized')
	await send('last')
	const result = await consume()
	expect(result).toMatchObject({ received: 1, status: 'limited', reason: 'inspection-limit' })
	expect(result.items[0].snapshotId).toBeNull()
	expect(result.items[0].inspectionWarning).toContain('was not retained')
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['last'])
})
it('clears consumed snapshots and receipts on reconnect', async () => {
	await start()
	const value = input(),
		result = await consume(value)
	await host.request('sb.disconnect', { ...request() })
	await expect(
		host.request('sb.inspect', { ...request(), snapshotId: result.items[0].snapshotId! }),
	).rejects.toThrow('Connection expired')
})

it('blocks receive-and-delete while a listener owns a receiver', async () => {
	await start()
	const listener = await host.request('sb.listener.start', {
		...request(),
		target: { kind: 'queue', name: 'empty' },
		mode: 'manual',
		sessionId: '',
		maxMessages: 100,
		maxSeconds: 30,
		maxLockSeconds: 10,
	})
	await expect(consume()).rejects.toThrow('Stop the listener')
	await host.request('sb.listener.stop', { ...request(), listenerId: listener.listenerId })
})
it('reports receiver cleanup failure without discarding consumed messages', async () => {
	await start()
	const result = await consume({
		...input({ kind: 'queue', name: 'purge-cleanup-fail' }),
		maxMessages: 1,
	})
	expect(result).toMatchObject({ received: 1, status: 'unknown', uncertain: true })
	expect(result.cleanupWarning).toContain('cleanup could not be confirmed')
	expect(result.items[0].snapshotId).not.toBeNull()
})
