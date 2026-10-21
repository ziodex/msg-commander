import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	eventHubSendSchema,
	eventDraftSchema,
	type EventHubSend,
	type EventDraft,
} from '../../src/shared/contracts/event-hubs/sending'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const profile = {
	id: randomUUID(),
	name: 'Events',
	service: 'event-hubs' as const,
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas' as const,
	tenantId: '',
	clientId: '',
	secret: 'offline',
	rememberSecret: false,
}
const request = () => ({ id: randomUUID(), connectionId })
async function start(access: 'read' | 'send' = 'read', hubName = 'telemetry') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const result = await host.request('eh.connect', {
		operationId: randomUUID(),
		profile,
		hubName,
		management: null,
		access,
	})
	connectionId = result.connectionId
	return result
}
const draft = (body = 'hello'): EventDraft => ({
	bodyBase64: Buffer.from(body).toString('base64'),
	contentType: 'text/plain',
	correlationId: '',
	properties: [],
})
const input = (hubName = 'send-normal'): EventHubSend => ({
	...request(),
	hubName,
	drafts: [draft()],
	routing: { kind: 'automatic' },
	repetitions: 1,
	batchSize: 100,
	maxSeconds: 5,
	delayMs: 0,
	acknowledged: true,
})
const run = (value = input(), signal?: AbortSignal) =>
	host.request('eh.send', value, { signal, waitForCancellation: true, timeout: 15000 })
const read = (hubName: string, count: number, partitionId = '0') =>
	host.request('eh.read', {
		...request(),
		hubName,
		consumerGroup: '$Default',
		partitionId,
		position: { kind: 'earliest' },
		maxEvents: count,
		maxSeconds: 1,
	})
afterEach(async () => {
	await host?.stop()
})
it('forwards producer routing, SDK byte bounds, typed AMQP values, cancellation and disposal', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-hubs-send-checks'], { encoding: 'utf8' }),
	).toContain('Event Hubs sending adapter checks passed')
})
it('splits broker-sized batches, repeats drafts in order, and retains exact IDs, metadata and bytes', async () => {
	await start()
	const value = {
		...input('send-split'),
		drafts: [
			draft('first'),
			{
				...draft(),
				bodyBase64: 'AP+AQQ==',
				contentType: 'application/octet-stream',
				correlationId: 'trace',
				properties: [
					{ name: 'large', type: 'uint64' as const, value: '18446744073709551615' },
				],
			},
		],
		repetitions: 3,
		routing: { kind: 'partition' as const, value: '1' },
	}
	expect(await run(value)).toMatchObject({
		status: 'completed',
		confirmed: 6,
		confirmedBatches: 3,
		uncertain: 0,
		lastBatchFirstIndex: 5,
		lastBatchCount: 2,
	})
	const events = await read(value.hubName, 6, '1')
	expect(events.received).toBe(6)
	for (let i = 0; i < 6; i++) {
		const details = await host.request('eh.inspect', {
			...request(),
			snapshotId: events.items[i].snapshotId!,
		})
		expect(details.messageId).toBe(`${value.id}:${i + 1}`)
		const body = await host.request('eh.body', {
			...request(),
			snapshotId: events.items[i].snapshotId!,
			offset: 0,
			count: 65536,
		})
		expect(body.base64).toBe(value.drafts[i % 2].bodyBase64)
		if (i % 2)
			expect(details).toMatchObject({
				contentType: 'application/octet-stream',
				correlationId: 'trace',
				applicationProperties: [
					{ name: 'large', type: 'uint64', value: '18446744073709551615' },
				],
			})
	}
})
it('preserves partition keys and supports empty event bodies', async () => {
	await start()
	const value = {
		...input(),
		drafts: [draft('')],
		routing: { kind: 'key' as const, value: 'device-42' },
	}
	expect((await run(value)).confirmed).toBe(1)
	const events = await read(value.hubName, 1)
	expect(events.items[0]).toMatchObject({ partitionKey: 'device-42', bodySize: 0 })
})
it('validates every draft and individual broker fit before any publish', async () => {
	await start()
	const value = { ...input('send-oversized'), drafts: [draft('valid'), draft('oversized')] }
	expect(await run(value)).toMatchObject({
		confirmed: 0,
		uncertain: 0,
		status: 'failed',
		lastBatchFirstIndex: null,
	})
	expect((await read(value.hubName, 1)).received).toBe(0)
	const invalid = {
		...input(),
		drafts: [
			draft('valid'),
			{
				...draft(),
				properties: [{ name: 'bad', type: 'int64' as const, value: '9223372036854775808' }],
			},
		],
	}
	expect(await run(invalid)).toMatchObject({ confirmed: 0, status: 'failed', uncertain: 0 })
	expect((await read(invalid.hubName, 1)).received).toBe(0)
})
it('distinguishes known rejection from an acknowledgement lost after broker acceptance without retrying', async () => {
	await start()
	for (const hub of ['send-reject', 'send-denied']) {
		const result = await run(input(hub))
		expect(result).toMatchObject({ status: 'failed', confirmed: 0, uncertain: 0 })
		expect(JSON.stringify(result)).not.toContain('SECRET')
	}
	const value = { ...input('send-unknown'), repetitions: 5, batchSize: 2 }
	const result = await run(value)
	expect(result).toMatchObject({
		status: 'unknown',
		confirmed: 0,
		uncertain: 2,
		lastBatchFirstIndex: 1,
		lastBatchCount: 2,
	})
	expect((await read(value.hubName, 3)).received).toBe(2)
	expect(await run(value)).toEqual(result)
	expect((await read(value.hubName, 3)).received).toBe(2)
})
it('retains confirmed counts before an uncertain batch and stops remaining batches', async () => {
	await start()
	const result = await run({ ...input('send-partial'), repetitions: 6, batchSize: 2 })
	expect(result).toMatchObject({
		status: 'unknown',
		confirmed: 2,
		confirmedBatches: 1,
		uncertain: 2,
		lastBatchFirstIndex: 3,
		lastBatchCount: 2,
	})
	expect((await read('send-partial', 3)).received).toBe(2)
})
it('cancels preflight with no attempted batches and retains a recoverable receipt', async () => {
	await start()
	const value = input('send-preflight-slow'),
		stop = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'event-hub-send-progress' &&
			e.operationId === value.id &&
			e.phase === 'validating'
		)
			setTimeout(() => stop.abort(), 50)
	})
	const result = await run(value, stop.signal)
	expect(result).toMatchObject({
		status: 'cancelled',
		confirmed: 0,
		uncertain: 0,
		lastBatchFirstIndex: null,
	})
	expect(await host.request('eh.send.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
})
it('marks cancellation during an in-flight send as uncertain', async () => {
	await start()
	const value = input('send-slow'),
		stop = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'event-hub-send-progress' &&
			e.operationId === value.id &&
			e.phase === 'sending'
		)
			setTimeout(() => stop.abort(), 50)
	})
	expect(await run(value, stop.signal)).toMatchObject({
		status: 'unknown',
		reason: 'cancelled',
		confirmed: 0,
		uncertain: 1,
	})
})
it('counts an acknowledged batch that completes after cancellation and stops subsequent work', async () => {
	await start()
	const value = { ...input('send-late'), repetitions: 4, batchSize: 2 },
		stop = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'event-hub-send-progress' &&
			e.operationId === value.id &&
			e.phase === 'sending'
		)
			setTimeout(() => stop.abort(), 50)
	})
	expect(await run(value, stop.signal)).toMatchObject({
		status: 'cancelled',
		reason: 'cancelled',
		confirmed: 2,
		confirmedBatches: 1,
		uncertain: 0,
	})
	expect((await read(value.hubName, 3)).received).toBe(2)
})
it('reports time bounds separately between batches and during an in-flight batch', async () => {
	await start()
	expect(
		await run({ ...input(), repetitions: 10, batchSize: 1, delayMs: 1000, maxSeconds: 1 }),
	).toMatchObject({ status: 'limited', reason: 'time', confirmed: 1, uncertain: 0 })
	expect(await run({ ...input('send-slow'), maxSeconds: 1 })).toMatchObject({
		status: 'unknown',
		reason: 'time',
		confirmed: 0,
		uncertain: 1,
	})
})
it('blocks another read or send after failed sender cleanup and blocks reconnect if cleanup still fails', async () => {
	await start()
	const value = input('send-cleanup'),
		result = await run(value)
	expect(result).toMatchObject({ status: 'failed', confirmed: 1, uncertain: 0 })
	expect(result.cleanupWarning).toContain('Disconnect')
	await expect(run()).rejects.toThrow('cleanup')
	await expect(read('telemetry', 1)).rejects.toThrow('cleanup')
	expect(await host.request('eh.send.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	await host.request('eh.reset', {})
	await expect(
		host.request('eh.connect', {
			operationId: randomUUID(),
			profile,
			hubName: 'telemetry',
			management: null,
		}),
	).rejects.toThrow('Restart the backend')
})
it('connects with publisher metadata access and blocks reads in send-only mode', async () => {
	expect(await start('send', 'send-only')).toMatchObject({
		access: 'send',
		initialHub: { name: 'send-only' },
	})
	expect((await run(input('send-only'))).confirmed).toBe(1)
	await expect(read('send-only', 1)).rejects.toThrow('Send-only mode')
	expect((await host.request('eh.hub', { ...request(), hubName: 'send-only' })).name).toBe(
		'send-only',
	)
})
it('rejects invalid routing, bounds and acknowledgement at both boundaries', async () => {
	await start()
	for (const change of [
		{ drafts: [] },
		{ repetitions: 1001 },
		{ repetitions: 501, drafts: [draft(), draft()] },
		{ batchSize: 0 },
		{ batchSize: 101 },
		{ maxSeconds: 0 },
		{ maxSeconds: 301 },
		{ delayMs: -1 },
		{ delayMs: 1001 },
		{ acknowledged: false },
		{ routing: { kind: 'automatic', value: '1' } },
		{ routing: { kind: 'partition', value: 'x' } },
		{ routing: { kind: 'key', value: '' } },
		{ routing: { kind: 'key', value: 'a', partitionId: '0' } },
	]) {
		const value = { ...input(), ...change }
		expect(eventHubSendSchema.safeParse(value).success).toBe(false)
		await expect(run(value as EventHubSend)).rejects.toThrow()
	}
})
it('rejects unsafe typed values, duplicate names and oversized draft data', async () => {
	await start()
	for (const [type, value] of [
		['uint64', '-1'],
		['int32', '2147483648'],
		['boolean', 'True'],
		['double', 'NaN'],
		['datetime', '2026-10-11T10:00:00'],
		['binary', '%'],
	]) {
		const invalid = { ...draft(), properties: [{ name: 'bad', type, value }] } as EventDraft
		expect(eventDraftSchema.safeParse(invalid).success).toBe(false)
		expect(await run({ ...input(), drafts: [invalid] })).toMatchObject({
			status: 'failed',
			confirmed: 0,
			uncertain: 0,
		})
	}
	const duplicate = {
		...draft(),
		properties: [
			{ name: 'same', type: 'string' as const, value: 'a' },
			{ name: 'same', type: 'string' as const, value: 'b' },
		],
	}
	expect(eventDraftSchema.safeParse(duplicate).success).toBe(false)
	expect(await run({ ...input(), drafts: [duplicate] })).toMatchObject({
		confirmed: 0,
		status: 'failed',
	})
	const oversized = { ...draft(), bodyBase64: Buffer.alloc(262145).toString('base64') }
	expect(await run({ ...input(), drafts: [oversized] })).toMatchObject({
		confirmed: 0,
		status: 'failed',
	})
})
it('retains receipts by operation ID, rejects changed requests and expires receipts on reset', async () => {
	await start()
	const value = input(),
		result = await run(value)
	expect(await run(value)).toEqual(result)
	await expect(run({ ...value, repetitions: 2 })).rejects.toThrow('another request')
	await expect(run({ ...input(), connectionId: randomUUID() })).rejects.toThrow('expired')
	expect(
		await host.request('eh.send.result', { ...request(), operationId: randomUUID() }),
	).toBeNull()
	await host.request('eh.reset', {})
	await expect(
		host.request('eh.send.result', { ...request(), operationId: value.id }),
	).rejects.toThrow('expired')
})
it('caps retained send receipts and routes fresh authentication codes to the send operation', async () => {
	await start()
	const value = input('send-reauth'),
		codes: string[] = []
	host.on('event', (e) => {
		if (e.type === 'device-code') codes.push(e.operationId)
	})
	await run(value)
	expect(codes.length).toBeGreaterThan(0)
	expect(new Set(codes)).toEqual(new Set([value.id]))
	for (let i = 1; i < 100; i++) await run()
	await expect(run()).rejects.toThrow('receipt limit')
})
