import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import type {
	MessageDraft,
	ReceiveRequest,
	SettleRequest,
	SendTarget,
} from '../../src/shared/message-operations'
import { composerBody } from '../../src/renderer/src/shared/lib/composer'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
afterEach(async () => {
	await host?.stop()
})
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Fixture',
				service: 'service-bus',
				namespace: 'fixture.servicebus.windows.net',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				rememberSecret: false,
				secret: 'fixture',
			},
		})
	).connectionId
}
const request = () => ({ id: randomUUID(), connectionId })
const queue = (name = 'orders'): SendTarget => ({ kind: 'queue', name })
const draft = (messageId: string = randomUUID()): MessageDraft => ({
	bodyBase64: Buffer.from('{"n":9007199254740993,"city":"Málaga 🚀"}').toString('base64'),
	messageId,
	subject: 'test',
	contentType: 'application/json',
	correlationId: 'correlation',
	sessionId: '',
	replyTo: '',
	replyToSessionId: '',
	to: '',
	partitionKey: '',
	ttlSeconds: 60,
	properties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
})
const send = (value = draft(), target = queue()) =>
	host.request('sb.send', { ...request(), target, draft: value })
const receive = (overrides: Partial<ReceiveRequest> = {}) =>
	host.request('sb.receive', {
		...request(),
		target: { kind: 'queue', name: 'orders' },
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
		...overrides,
	})
const settle = (deliveryId: string, action: SettleRequest['action'], overrides = {}) =>
	host.request('sb.settle', {
		...request(),
		deliveryId,
		action,
		reason: 'ValidationFailed',
		description: 'Bad value',
		...overrides,
	})
const held = () => host.request('sb.deliveries', request())
const peek = (target = queue(), subQueue: 'active' | 'dead-letter' = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: target as { kind: 'queue'; name: string },
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})

it('routes writes through SDK adapters and rolls back a transaction when send fails', () => {
	expect(execFileSync('dotnet', [dll, '--mutation-checks'], { encoding: 'utf8' })).toContain(
		'Mutation adapter checks passed',
	)
})

it('encodes the composer without rounding JSON numbers or corrupting Unicode and binary bytes', () => {
	const text = '{"n":9007199254740993,"city":"Málaga 🚀"}'
	expect(Buffer.from(composerBody(text, 'json').base64, 'base64').toString()).toBe(text)
	expect(composerBody('AP9B', 'base64')).toEqual({ base64: 'AP9B', size: 3 })
	expect(() => composerBody('{', 'json')).toThrow('valid JSON')
	expect(() => composerBody('bad?', 'base64')).toThrow('base64')
	expect(() => composerBody('x'.repeat(262145), 'text')).toThrow('256 KiB')
})
it('sends queue/topic messages and preserves typed properties, exact bodies and per-request receipts', async () => {
	await start()
	const value = draft('round-trip')
	const input = { ...request(), target: queue(), draft: value }
	expect((await host.request('sb.send', input)).status).toBe('confirmed')
	expect(await host.request('sb.send', input)).toEqual(
		await host.request('sb.outcome', { ...request(), operationId: input.id }),
	)
	expect((await peek()).items).toHaveLength(1)
	await expect(
		host.request('sb.send', { ...input, draft: draft('changed') }),
	).rejects.toMatchObject({ code: '-32602' })
	const delivery = (await receive()).items[0]
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: delivery.summary.snapshotId!,
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'exact',
		type: 'int64',
		value: '9223372036854775807',
	})
	const bytes = await host.request('sb.body', {
		...request(),
		snapshotId: delivery.summary.snapshotId!,
		offset: 0,
		count: 65536,
	})
	expect(bytes.base64).toBe(value.bodyBase64)
	await settle(delivery.deliveryId, 'complete')
	expect((await peek()).items).toHaveLength(0)
	await send(draft('topic-message'), { kind: 'topic', name: 'order-events' })
	expect(
		(
			await receive({
				target: { kind: 'subscription', name: 'billing', topicName: 'order-events' },
			})
		).items[0].summary.messageId,
	).toBe('topic-message')
})
it('rejects invalid properties before publishing and reports denial without SDK text', async () => {
	await start()
	for (const property of [
		{ name: 'bad', type: 'int64' as const, value: '9223372036854775808' },
		{ name: 'bad', type: 'double' as const, value: 'NaN' },
		{ name: 'bad', type: 'boolean' as const, value: 'yes' },
		{
			name: 'bad',
			type: 'decimal' as const,
			value: '0.12345678901234567890123456789123456789',
		},
		{ name: 'bad', type: 'datetime' as const, value: '2026-10-10T12:00:00' },
	]) {
		expect((await send({ ...draft(), properties: [property] })).status).toBe('rejected')
	}
	const denied = await send(draft('reject-send'))
	expect(denied.status).toBe('rejected')
	expect(denied.summary).toContain('Send rights')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
	const tooLarge = await send({ ...draft(), bodyBase64: Buffer.alloc(262145).toString('base64') })
	expect(tooLarge.status).toBe('rejected')
})
it('preserves supported property types and parses UTC timestamps and invariant durations', async () => {
	await start()
	const value = draft('types')
	value.properties = [
		{ name: 'flag', type: 'boolean', value: 'true' },
		{ name: 'count', type: 'int32', value: '-42' },
		{ name: 'unsigned', type: 'uint64', value: '18446744073709551615' },
		{ name: 'fraction', type: 'double', value: '1.25' },
		{ name: 'money', type: 'decimal', value: '1234567890123456789.25' },
		{ name: 'key', type: 'guid', value: '99a1a4e6-1ce2-4e65-8727-a44d106b8972' },
		{ name: 'when', type: 'datetime', value: '2026-10-10T12:00:00Z' },
		{ name: 'duration', type: 'timespan', value: '1.02:03:04' },
	]
	expect((await send(value)).status).toBe('confirmed')
	const delivery = (await receive()).items[0]
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: delivery.summary.snapshotId!,
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'money',
		type: 'decimal',
		value: '1234567890123456789.25',
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'unsigned',
		type: 'uint64',
		value: '18446744073709551615',
	})
	expect(details.applicationProperties.find((p) => p.name === 'when')?.value).toContain(
		'2026-10-10T12:00:00',
	)
})
it('requires owned handles and supports renew, abandon, dead-letter and complete without settling peek snapshots', async () => {
	await start()
	const snapshot = (await peek()).items[0].snapshotId!
	expect((await settle(snapshot, 'complete')).status).toBe('rejected')
	const first = (await receive()).items[0]
	await expect(receive()).rejects.toMatchObject({ code: '-32020' })
	expect((await settle(first.deliveryId, 'renew')).status).toBe('confirmed')
	expect(Date.parse((await held()).items[0].lockedUntil)).toBeGreaterThan(
		Date.parse(first.lockedUntil),
	)
	await settle(first.deliveryId, 'abandon')
	expect((await held()).items[0].state).toBe('abandoned')
	const second = (await receive()).items[0]
	await settle(second.deliveryId, 'dead-letter')
	const dlq = await receive({ subQueue: 'dead-letter', maxMessages: 2 })
	expect(dlq.items.map((item) => item.summary.messageId)).toContain(first.summary.messageId)
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: dlq.items[0].summary.snapshotId!,
	})
	expect(details.systemProperties).toContainEqual({
		name: 'DeadLetterReason',
		type: 'string',
		value: 'ValidationFailed',
	})
	expect((await settle(dlq.items[0].deliveryId, 'dead-letter')).status).toBe('rejected')
	for (const item of dlq.items) await settle(item.deliveryId, 'complete')
	expect((await held()).items.every((item) => item.state === 'completed')).toBe(true)
	expect((await settle(first.deliveryId, 'complete')).status).toBe('rejected')
})
it('supports explicit sessions and preserves a received snapshot when peeking again', async () => {
	await start()
	const batch = await receive({
		target: { kind: 'queue', name: 'sessions' },
		sessionId: 'session-001',
	})
	expect(batch.items[0].summary.sessionId).toBe('session-001')
	await peek()
	await expect(
		host.request('sb.inspect', {
			...request(),
			snapshotId: batch.items[0].summary.snapshotId!,
		}),
	).resolves.toHaveProperty('summary')
	await settle(batch.items[0].deliveryId, 'defer')
	expect((await held()).items[0].state).toBe('deferred')
	const deferred = (
		await receive({
			target: { kind: 'queue', name: 'sessions' },
			sessionId: 'session-001',
			deferredSequence: batch.items[0].summary.sequenceNumber,
		})
	).items[0]
	expect(deferred.summary.sequenceNumber).toBe(batch.items[0].summary.sequenceNumber)
	expect((await settle(deferred.deliveryId, 'complete')).status).toBe('confirmed')
	await expect(
		receive({
			target: { kind: 'queue', name: 'sessions' },
			sessionId: 'session-001',
			deferredSequence: deferred.summary.sequenceNumber,
		}),
	).rejects.toMatchObject({ code: '-32022' })
	await host.request('sb.close-receiver', request())
	await expect(
		host.request('sb.inspect', {
			...request(),
			snapshotId: batch.items[0].summary.snapshotId!,
		}),
	).rejects.toMatchObject({ code: '-32013' })
})
it('blocks a lost or uncertain settlement handle and never repeats an uncertain send', async () => {
	await start()
	const input = { ...request(), target: queue('outbox'), draft: draft('unknown-send') }
	expect((await host.request('sb.send', input)).status).toBe('unknown')
	expect((await host.request('sb.send', input)).status).toBe('unknown')
	expect((await peek(queue('outbox'))).items).toHaveLength(1)
	await send(draft('lose-lock'))
	const first = (await receive()).items[0]
	expect((await settle(first.deliveryId, 'complete')).status).toBe('rejected')
	expect((await held()).items[0].state).toBe('lock-lost')
	await send(draft('unknown-complete'), queue('unknown-settlement'))
	const second = (
		await receive({ target: queue('unknown-settlement') as { kind: 'queue'; name: string } })
	).items[0]
	expect((await settle(second.deliveryId, 'complete')).status).toBe('unknown')
	expect((await held()).items[0].state).toBe('unknown')
	expect((await settle(second.deliveryId, 'complete')).status).toBe('rejected')
})
it('retains a confirmed receipt when broker success races cancellation and recovers partial receives', async () => {
	await start()
	const controller = new AbortController()
	const input = { ...request(), target: queue(), draft: draft('commit-late') }
	const pending = host.request('sb.send', input, { signal: controller.signal })
	setTimeout(() => controller.abort(), 50)
	await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
	expect(
		(await host.request('sb.outcome', { ...request(), operationId: input.id }))?.status,
	).toBe('confirmed')
	const cancel = new AbortController()
	const receiving = host.request(
		'sb.receive',
		{
			...request(),
			target: { kind: 'queue', name: 'partial' },
			subQueue: 'active',
			sessionId: '',
			maxMessages: 2,
			waitSeconds: 20,
		},
		{ signal: cancel.signal },
	)
	setTimeout(() => cancel.abort(), 50)
	await expect(receiving).rejects.toMatchObject({ code: 'CANCELLED' })
	const batch = await held()
	expect(batch.items).toHaveLength(1)
	expect(batch.warning).toContain('interrupted')
	expect((await settle(batch.items[0].deliveryId, 'abandon')).status).toBe('confirmed')
})
it('replays DLQ messages atomically, preserves payload metadata, and retains the source on rollback', async () => {
	await start()
	const first = (await receive({ subQueue: 'dead-letter' })).items[0]
	const input = {
		...request(),
		deliveryId: first.deliveryId,
		destination: queue('reject-replay'),
		idPolicy: 'new' as const,
		messageId: 'replayed-001',
	}
	expect((await host.request('sb.replay', input)).status).toBe('rejected')
	expect((await held()).items[0].state).toBe('active')
	expect((await peek(queue(), 'dead-letter')).items).toHaveLength(1)
	const success = {
		...input,
		...request(),
		destination: { kind: 'topic' as const, name: 'order-events' },
	}
	expect((await host.request('sb.replay', success)).status).toBe('confirmed')
	expect((await held()).items[0].state).toBe('replayed')
	expect((await peek(queue(), 'dead-letter')).items).toHaveLength(0)
	const delivered = (
		await receive({
			target: { kind: 'subscription', name: 'billing', topicName: 'order-events' },
		})
	).items[0]
	expect(delivered.summary.messageId).toBe('replayed-001')
	const body = await host.request('sb.body', {
		...request(),
		snapshotId: delivered.summary.snapshotId!,
		offset: 0,
		count: 10,
	})
	expect(body.base64).toBe('AP9B')
	const properties = await host.request('sb.inspect', {
		...request(),
		snapshotId: delivered.summary.snapshotId!,
	})
	expect(properties.applicationProperties).toContainEqual({
		name: 'exact',
		type: 'int64',
		value: '9223372036854775807',
	})
	expect(properties.applicationProperties.some((p) => p.name.startsWith('DeadLetter'))).toBe(
		false,
	)
	expect(
		(
			await host.request('sb.replay', {
				...request(),
				deliveryId: delivered.deliveryId,
				destination: queue(),
				idPolicy: 'new',
				messageId: 'not-a-dlq',
			})
		).status,
	).toBe('rejected')
})
it('keeps uncertain replay outcomes blocked and validates the message-ID policy', async () => {
	await start()
	const delivery = (await receive({ subQueue: 'dead-letter' })).items[0]
	const input = {
		...request(),
		deliveryId: delivery.deliveryId,
		destination: queue('unknown-replay'),
		idPolicy: 'preserve' as const,
		messageId: 'wrong',
	}
	expect((await host.request('sb.replay', input)).status).toBe('rejected')
	const uncertain = { ...input, ...request(), messageId: delivery.summary.messageId! }
	expect((await host.request('sb.replay', uncertain)).status).toBe('unknown')
	expect((await host.request('sb.replay', uncertain)).status).toBe('unknown')
	expect((await peek(queue('unknown-replay'))).items).toHaveLength(1)
	expect((await held()).items[0].state).toBe('unknown')
	await host.request('sb.reset', {})
	await expect(settle(delivery.deliveryId, 'complete')).rejects.toMatchObject({ code: '-32010' })
})

it('resends a peeked snapshot losslessly without receiving or deleting the source, and retains a single receipt', async () => {
	await start()
	const original = draft('snapshot-original')
	original.bodyBase64 = 'AP+AQQ=='
	await send(original, queue('empty'))
	const summary = (await peek(queue('empty'))).items[0]
	const input = {
		...request(),
		snapshotId: summary.snapshotId!,
		destination: queue('outbox'),
		idPolicy: 'new' as const,
		messageId: 'snapshot-copy',
	}
	const receipt = await host.request('sb.snapshot.resend', input)
	expect(receipt.status).toBe('confirmed')
	expect(await host.request('sb.snapshot.resend', input)).toEqual(receipt)
	expect((await held()).target).toBeNull()
	expect((await peek(queue('empty'))).items.map((m) => m.messageId)).toEqual([
		'snapshot-original',
	])
	const copy = (await peek(queue('outbox'))).items
	expect(copy).toHaveLength(1)
	expect(copy[0].messageId).toBe('snapshot-copy')
	expect(
		(
			await host.request('sb.body', {
				...request(),
				snapshotId: copy[0].snapshotId!,
				offset: 0,
				count: 65536,
			})
		).base64,
	).toBe(original.bodyBase64)
	expect(
		(await host.request('sb.inspect', { ...request(), snapshotId: copy[0].snapshotId! }))
			.applicationProperties,
	).toContainEqual({ name: 'exact', type: 'int64', value: '9223372036854775807' })
	await expect(
		host.request('sb.snapshot.resend', { ...input, messageId: 'different' }),
	).rejects.toMatchObject({ code: '-32602' })
	expect((await host.request('sb.snapshot.resend', { ...input, id: randomUUID() })).status).toBe(
		'rejected',
	) // old peek handle expired
})
it('preserves a snapshot send with an unknown outcome without retrying and rejects invalid ID policy', async () => {
	await start()
	await send(draft('original'), queue('empty'))
	const summary = (await peek(queue('empty'))).items[0]
	const input = {
		...request(),
		snapshotId: summary.snapshotId!,
		destination: queue('outbox'),
		idPolicy: 'preserve' as const,
		messageId: 'wrong',
	}
	expect((await host.request('sb.snapshot.resend', input)).status).toBe('rejected')
	const unknown = {
		...input,
		id: randomUUID(),
		idPolicy: 'new' as const,
		messageId: 'unknown-send',
	}
	expect((await host.request('sb.snapshot.resend', unknown)).status).toBe('unknown')
	expect((await host.request('sb.snapshot.resend', unknown)).status).toBe('unknown')
	expect((await peek(queue('outbox'))).items).toHaveLength(1)
	expect((await peek(queue('empty'))).items[0].messageId).toBe('original')
})
