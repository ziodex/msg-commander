import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import {
	eventListenSchema,
	type EventListen,
	type EventCheckpoint,
} from '../../src/shared/contracts/event-hubs/listening'
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
async function start(access: 'read' | 'send' = 'read') {
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	connectionId = (
		await host.request('eh.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Events',
				service: 'event-hubs',
				namespace: 'fixture.servicebus.windows.net',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'offline',
				rememberSecret: false,
			},
			hubName: 'telemetry',
			management: null,
			access,
		})
	).connectionId
}
function input(hubName = 'listen-many', maxEvents = 24): EventListen {
	return {
		...req(),
		hubName,
		consumerGroup: '$Default',
		start: { kind: 'earliest' },
		concurrency: 2,
		maxEvents,
		maxSeconds: 10,
		acknowledged: true,
	}
}
const listen = (value: EventListen, signal?: AbortSignal) =>
	host.request('eh.listen', value, { signal, timeout: 20000, waitForCancellation: true })
afterEach(async () => {
	await host?.stop()
})
it('reads every partition through bounded receivers, exact global limits and final local positions', async () => {
	await start()
	const progress: any[] = []
	host.on('event', (e) => {
		if (e.type === 'event-hub-listen-progress') progress.push(e)
	})
	const value = input(),
		result = await listen(value)
	expect(result.status).toBe('completed')
	expect(result.received).toBe(24)
	expect(result.partitions).toHaveLength(8)
	expect(result.partitions.every((p) => p.received === 3)).toBe(true)
	expect(Math.max(...progress.map((p) => p.activeReceivers))).toBe(2)
	expect(progress.at(-1).activeReceivers).toBe(0)
	expect(
		result.checkpoint?.partitions.every(
			(p) =>
				p.position.kind === 'sequence' &&
				p.position.value === '9007199254740995' &&
				!p.position.inclusive,
		),
	).toBe(true)
	expect(JSON.stringify(result)).not.toContain('offline')
	expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(1048576)
	const meta = await host.request('eh.export', {
		...req(),
		snapshotId: result.items[0].snapshotId!,
	})
	expect(meta).toMatchObject({
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'listen-many',
		partitionId: result.items[0].partitionId,
	})
	expect(
		(await host.request('eh.listen.result', { ...req(), operationId: value.id }))?.received,
	).toBe(24)
	expect((await listen(value)).received).toBe(24)
	await expect(listen({ ...value, maxEvents: 1 })).rejects.toThrow('another request')
}, 20000)
it('resumes per-partition positions without repeating retained events when concurrency changes', async () => {
	await start()
	const first = await listen(input('listen-many', 8))
	const second = await listen({
		...input('listen-many', 16),
		concurrency: 4,
		start: { kind: 'checkpoint', checkpoint: first.checkpoint! },
	})
	expect(second.received).toBe(16)
	const identities = [...first.items, ...second.items].map(
		(i) => i.partitionId + ':' + i.sequenceNumber,
	)
	expect(new Set(identities).size).toBe(24)
}, 20000)
it('resumes a checkpoint created under the previous product name', async () => {
	await start()
	const first = await listen(input('listen-many', 8))
	const checkpoint = {
		...first.checkpoint!,
		format: 'service-bus-commander/event-checkpoints',
	} as unknown as EventCheckpoint
	const next = await listen({
		...input('listen-many', 16),
		start: { kind: 'checkpoint', checkpoint },
	})
	expect(next.received).toBe(16)
	expect(next.checkpoint?.format).toBe('msg-commander/event-checkpoints')
	expect(
		new Set(
			[...first.items, ...next.items].map(
				(event) => `${event.partitionId}:${event.sequenceNumber}`,
			),
		).size,
	).toBe(24)
}, 20000)
it('cancels and retains partial progress and a resumable position for every partition', async () => {
	await start()
	const abort = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'event-hub-listen-progress' && e.received >= 2) abort.abort()
	})
	const value = await listen(input('listen-paced', 100), abort.signal)
	expect(value.status).toBe('cancelled')
	expect(value.received).toBeGreaterThanOrEqual(2)
	expect(value.received).toBeLessThan(100)
	expect(value.checkpoint?.partitions).toHaveLength(8)
	expect(value.partitions.reduce((a, p) => a + p.received, 0)).toBe(value.received)
})
it('uses the time limit for idle latest reads without advancing any partition past its original boundary', async () => {
	await start()
	const value = await listen({
		...input('listen-many', 100),
		start: { kind: 'latest' },
		maxSeconds: 1,
	})
	expect(value).toMatchObject({ received: 0, status: 'limited', reason: 'time' })
	expect(
		value.checkpoint?.partitions.every(
			(p) => p.position.kind === 'sequence' && p.position.value === '9007199254740995',
		),
	).toBe(true)
})
it('rejects mismatched scope, recreated hubs, changed partition sets and stale/future checkpoints before reading', async () => {
	await start()
	const first = await listen(input('telemetry', 1)),
		checkpoint = first.checkpoint!
	for (const change of [
		{ namespace: 'another.servicebus.windows.net' },
		{ hubName: 'another' },
		{ consumerGroup: 'another' },
	])
		await expect(
			listen({
				...input('telemetry', 1),
				start: { kind: 'checkpoint', checkpoint: { ...checkpoint, ...change } },
			}),
		).rejects.toThrow('must match')
	for (const changed of [
		{ ...checkpoint, hubCreatedAt: '2020-01-01T00:00:00Z' },
		{ ...checkpoint, partitions: checkpoint.partitions.slice(1) },
		{
			...checkpoint,
			partitions: checkpoint.partitions.map((p) => ({
				...p,
				position: { kind: 'sequence' as const, value: '1', inclusive: true },
			})),
		},
		{
			...checkpoint,
			partitions: checkpoint.partitions.map((p) => ({
				...p,
				position: {
					kind: 'sequence' as const,
					value: '9223372036854775807',
					inclusive: false,
				},
			})),
		},
	]) {
		const result = await listen({
			...input('telemetry', 1),
			start: { kind: 'checkpoint', checkpoint: changed },
		})
		expect(result).toMatchObject({ received: 0, status: 'failed', checkpoint: null })
	}
})
it('stops on receive errors and keeps retained events with safe errors and cleanup outcomes', async () => {
	await start()
	const result = await listen(input('listen-fail', 100))
	expect(result.status).toBe('failed')
	expect(result.received).toBeGreaterThan(0)
	expect(result.partitions.some((p) => p.error)).toBe(true)
	expect(JSON.stringify(result)).not.toContain('SECRET')
	const bad = await listen(input('listen-cleanup', 1))
	expect(bad.cleanupWarning).toBeTruthy()
	await expect(listen(input())).rejects.toThrow('cleanup')
})
it('stops at the body budget without checkpointing an event that was not retained', async () => {
	await start()
	const result = await listen(input('budget', 10))
	expect(result).toMatchObject({ received: 1, reason: 'buffer-limit', status: 'limited' })
	expect(result.checkpoint?.partitions[0].position).toEqual({
		kind: 'sequence',
		value: '9007199254740993',
		inclusive: false,
	})
})
it('validates limits and acknowledgement at both boundaries and refuses send-only receivers', async () => {
	await start()
	for (const change of [
		{ concurrency: 0 },
		{ concurrency: 17 },
		{ maxEvents: 1001 },
		{ maxSeconds: 3601 },
		{ acknowledged: false },
	]) {
		const value = { ...input(), ...change }
		expect(eventListenSchema.safeParse(value).success).toBe(false)
		await expect(listen(value as EventListen)).rejects.toThrow()
	}
	await host.stop()
	await start('send')
	await expect(listen(input())).rejects.toThrow('read mode')
})
it('rejects invalid/extra checkpoint fields independently in the host and expires receipts on reconnect', async () => {
	await start()
	const value = input('telemetry', 1),
		result = await listen(value)
	const invalid = {
		...result.checkpoint!,
		partitions: [...result.checkpoint!.partitions, result.checkpoint!.partitions[0]],
	}
	expect(
		eventListenSchema.safeParse({
			...input(),
			start: { kind: 'checkpoint', checkpoint: invalid },
		}).success,
	).toBe(false)
	await expect(
		listen({ ...input('telemetry', 1), start: { kind: 'checkpoint', checkpoint: invalid } }),
	).rejects.toThrow()
	await expect(
		listen({
			...input('telemetry', 1),
			start: {
				kind: 'checkpoint',
				checkpoint: { ...result.checkpoint!, path: '/tmp/ignored' } as EventCheckpoint,
			},
		}),
	).rejects.toThrow()
	await host.request('eh.disconnect', req())
	await expect(
		host.request('eh.listen.result', { ...req(), operationId: value.id }),
	).rejects.toThrow('expired')
})

it('verifies actual receiver allocation, disposal and non-exclusive SDK options', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--event-hubs-listening-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('concurrency and cleanup checks passed')
}, 15000)
it('keeps 1,024-partition progress and checkpoint receipts within the protocol frame limit', async () => {
	await start()
	const result = await listen({ ...input('listen-1024', 1), concurrency: 16 })
	expect(result.received).toBe(1)
	expect(result.partitions).toHaveLength(1024)
	expect(result.checkpoint?.partitions).toHaveLength(1024)
	expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(1048576)
})
