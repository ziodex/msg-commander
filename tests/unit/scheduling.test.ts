import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	batchRequestSchema,
	cancelScheduledRequestSchema,
	type MessageDraft,
	type SendTarget,
} from '../../src/shared/message-operations'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const target: SendTarget = { kind: 'queue', name: 'orders' }
const topic: SendTarget = { kind: 'topic', name: 'order-events' }
const future = () => new Date(Date.now() + 3600000).toISOString()
const request = (destination: SendTarget = target) => ({
	id: randomUUID(),
	connectionId,
	target: destination,
})
const draft = (messageId: string = randomUUID()): MessageDraft => ({
	bodyBase64: 'AP9B',
	messageId,
	subject: 'scheduled',
	contentType: 'application/octet-stream',
	correlationId: '',
	sessionId: '',
	replyTo: '',
	replyToSessionId: '',
	to: '',
	partitionKey: '',
	ttlSeconds: 60,
	properties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
})
const send = (
	drafts = [draft()],
	scheduledEnqueueTime: string | null = future(),
	destination: SendTarget = target,
) => host.request('sb.send.batch', { ...request(destination), drafts, scheduledEnqueueTime })
const browse = (destination: SendTarget = target, fromSequenceNumber = '0', maxMessages = 25) =>
	host.request('sb.scheduled', { ...request(destination), fromSequenceNumber, maxMessages })
const cancel = (
	sequenceNumbers: string[],
	destination: SendTarget = target,
	confirmation = `${destination.kind}/${destination.name}`,
) => host.request('sb.scheduled.cancel', { ...request(destination), sequenceNumbers, confirmation })
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
it('uses SDK atomic batches, rejects a batch that cannot fit before dispatch, and routes topic peeks and cancellation', () => {
	expect(execFileSync('dotnet', [dll, '--scheduling-checks'], { encoding: 'utf8' })).toContain(
		'Scheduling adapter checks passed',
	)
})
it('round-trips scheduled queue and topic bodies, metadata, times and precise sequence numbers', async () => {
	await start()
	for (const destination of [target, topic]) {
		const time = future()
		const result = await send([draft('one'), draft('two')], time, destination)
		expect(result.status).toBe('confirmed')
		expect(result.sequenceNumbers).toHaveLength(2)
		expect(BigInt(result.sequenceNumbers![0])).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
		const page = await browse(destination)
		expect(page.items.map((item) => item.sequenceNumber)).toEqual(result.sequenceNumbers)
		expect(Date.parse(page.items[0].scheduledEnqueueTime!)).toBe(Date.parse(time))
		const snapshotId = page.items[0].snapshotId!
		expect(
			(await host.request('sb.body', { ...request(), snapshotId, offset: 0, count: 10 }))
				.base64,
		).toBe('AP9B')
		expect(
			(await host.request('sb.inspect', { ...request(), snapshotId })).applicationProperties,
		).toContainEqual({ name: 'exact', type: 'int64', value: '9223372036854775807' })
		const cancelled = await cancel(result.sequenceNumbers!, destination)
		expect(cancelled.status).toBe('confirmed')
		expect(cancelled.summary).toContain('Activation can race')
		expect((await browse(destination)).items).toHaveLength(0)
	}
})
it('sends distinct immediate drafts once and pages through active entries before finding schedules', async () => {
	await start()
	expect(
		(
			await send(
				Array.from({ length: 20 }, (_, i) => draft(`active-${i}`)),
				null,
			)
		).status,
	).toBe('confirmed')
	await send([draft('scheduled-last')])
	const first = await browse(target, '0', 20)
	expect(first.items).toHaveLength(0)
	expect(first.nextSequenceNumber).not.toBeNull()
	const next = await browse(target, first.nextSequenceNumber!)
	expect(next.items.map((item) => item.messageId)).toEqual(['scheduled-last'])
	const received = await host.request('sb.receive', {
		...request(),
		target: { kind: 'queue', name: 'orders' },
		subQueue: 'active',
		sessionId: '',
		maxMessages: 10,
		waitSeconds: 1,
	})
	expect(received.items).toHaveLength(10)
	expect(received.items.every((item) => item.summary.state === 'Active')).toBe(true)
})
it('validates every draft, common session/partition, count, size and timestamp before publishing', async () => {
	await start()
	const invalidSets = [
		[],
		Array.from({ length: 21 }, () => draft()),
		[draft('same'), draft('same')],
		[
			draft(),
			{
				...draft(),
				properties: [{ name: 'bad', type: 'int64' as const, value: '9223372036854775808' }],
			},
		],
		[draft(), { ...draft(), sessionId: 'different' }],
		[{ ...draft(), sessionId: 'a', partitionKey: 'b' }],
		[draft(), { ...draft(), bodyBase64: Buffer.alloc(262145).toString('base64') }],
		Array.from({ length: 3 }, () => ({
			...draft(),
			bodyBase64: Buffer.alloc(140000).toString('base64'),
		})),
	]
	for (const drafts of invalidSets) expect((await send(drafts)).status).toBe('rejected')
	for (const time of ['2020-01-01T00:00:00Z', '2040-01-01T00:00:00', 'bad'])
		expect((await send([draft()], time)).status).toBe('rejected')
	expect(
		(
			await host.request('sb.send.batch', {
				...request(),
				drafts: [draft()],
				scheduledEnqueueTime: 42,
			} as never)
		).status,
	).toBe('rejected')
	expect((await browse()).items).toHaveLength(0)
	expect((await send([draft('reject-batch')])).status).toBe('rejected')
	expect((await browse()).items).toHaveLength(0)
})
it('validates IPC limits and preserves sequence numbers without numeric coercion', () => {
	const base = { id: randomUUID(), connectionId: randomUUID(), target }
	expect(
		batchRequestSchema.safeParse({
			...base,
			drafts: [draft(), draft()],
			scheduledEnqueueTime: future(),
		}).success,
	).toBe(true)
	expect(
		batchRequestSchema.safeParse({
			...base,
			drafts: [draft('x'), draft('x')],
			scheduledEnqueueTime: null,
		}).success,
	).toBe(false)
	expect(
		batchRequestSchema.safeParse({
			...base,
			drafts: Array.from({ length: 3 }, () => ({
				...draft(),
				bodyBase64: Buffer.alloc(140000).toString('base64'),
			})),
			scheduledEnqueueTime: null,
		}).success,
	).toBe(false)
	for (const sequences of [[9007199254740992], ['9223372036854775808'], ['01'], ['1', '1'], []])
		expect(
			cancelScheduledRequestSchema.safeParse({
				...base,
				sequenceNumbers: sequences,
				confirmation: 'queue/orders',
			}).success,
		).toBe(false)
	expect(
		cancelScheduledRequestSchema.safeParse({
			...base,
			sequenceNumbers: ['9223372036854775807'],
			confirmation: 'queue/orders',
		}).success,
	).toBe(true)
})
it('requires destination confirmation, keeps cancellation scoped, rejects subscriptions and stale connections', async () => {
	await start()
	const result = await send()
	expect((await cancel(result.sequenceNumbers!, target, 'orders')).status).toBe('rejected')
	for (const values of [[], ['01'], ['9223372036854775808'], ['1', '1']])
		expect((await cancel(values)).status).toBe('rejected')
	await cancel(result.sequenceNumbers!, topic)
	expect((await browse()).items).toHaveLength(1)
	const invalid = {
		...request(),
		target: { kind: 'subscription', name: 'audit', topicName: 'order-events' },
	}
	expect(
		(
			await host.request('sb.send.batch', {
				...invalid,
				drafts: [draft()],
				scheduledEnqueueTime: null,
			} as never)
		).status,
	).toBe('rejected')
	await expect(
		host.request('sb.scheduled', {
			...invalid,
			fromSequenceNumber: '0',
			maxMessages: 25,
		} as never),
	).rejects.toMatchObject({ code: '-32602' })
	await host.request('sb.reset', {})
	await expect(browse()).rejects.toMatchObject({ code: '-32010' })
})
it('keeps confirmed schedule receipts when cancellation races acknowledgements, without resending', async () => {
	await start()
	const input = { ...request(), drafts: [draft('commit-late')], scheduledEnqueueTime: future() }
	const controller = new AbortController()
	const pending = host.request('sb.send.batch', input, { signal: controller.signal })
	setTimeout(() => controller.abort(), 50)
	await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
	const receipt = await host.request('sb.outcome', { ...request(), operationId: input.id })
	expect(receipt?.status).toBe('confirmed')
	expect(receipt?.sequenceNumbers).toHaveLength(1)
	expect(await host.request('sb.send.batch', input)).toEqual(receipt)
	expect((await browse()).items).toHaveLength(1)
	await expect(
		host.request('sb.send.batch', { ...input, drafts: [draft('changed')] }),
	).rejects.toMatchObject({ code: '-32602' })
})
it('records cancellation before dispatch and unknown scheduling/cancellation outcomes without repeating writes', async () => {
	await start()
	const input = {
		...request(),
		drafts: [draft('slow-preflight')],
		scheduledEnqueueTime: future(),
	}
	const controller = new AbortController()
	const pending = host.request('sb.send.batch', input, { signal: controller.signal })
	setTimeout(() => controller.abort(), 50)
	await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
	expect(
		(await host.request('sb.outcome', { ...request(), operationId: input.id }))?.status,
	).toBe('cancelled')
	const uncertain = {
		...request(),
		drafts: [draft('unknown-batch'), draft('other')],
		scheduledEnqueueTime: future(),
	}
	for (let i = 0; i < 2; i++)
		expect((await host.request('sb.send.batch', uncertain)).status).toBe('unknown')
	expect((await browse()).items).toHaveLength(2)
	const destination: SendTarget = { kind: 'queue', name: 'cancel-unknown' }
	const scheduled = await send([draft()], future(), destination)
	const cancellation = {
		...request(destination),
		sequenceNumbers: scheduled.sequenceNumbers!,
		confirmation: 'queue/cancel-unknown',
	}
	const result = await host.request('sb.scheduled.cancel', cancellation)
	expect(result.status).toBe('unknown')
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(await host.request('sb.scheduled.cancel', cancellation)).toEqual(result)
	expect((await browse(destination)).items).toHaveLength(0)
})
