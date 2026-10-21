import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { eventHubUrl } from '../../src/main/features/event-hubs/urls'
import {
	eventHubCopyUrlSchema,
	type EventHubUrlTarget,
} from '../../src/shared/contracts/event-hubs/core'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
async function start(
	access: 'read' | 'send' = 'read',
	service: 'event-hubs' | 'iot-hub' = 'event-hubs',
) {
	host = new Backend('dotnet', [dll])
	await host.start()
	const value = await host.request('eh.connect', {
		operationId: randomUUID(),
		profile: {
			id: randomUUID(),
			name: 'Stats',
			service,
			namespace: 'fixture.servicebus.windows.net',
			auth: 'sas',
			tenantId: '',
			clientId: '',
			secret:
				service === 'iot-hub'
					? 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Service;SharedAccessKey=ZmFrZQ==;EntityPath=telemetry'
					: 'offline',
			rememberSecret: false,
		},
		hubName: 'telemetry',
		management: null,
		access,
	})
	connectionId = value.connectionId
}
afterEach(async () => {
	await host?.stop()
})
const read = (hubName = 'telemetry', maxEvents = 3, position = { kind: 'earliest' as const }) =>
	host.request('eh.read', {
		...request(),
		hubName,
		consumerGroup: '$Default',
		partitionId: '0',
		position,
		maxEvents,
		maxSeconds: 1,
	})
it.each(['https', 'sb'] as const)(
	'copies validated %s resource URLs with encoded consumer groups and no credentials',
	(scheme) => {
		const targets: [EventHubUrlTarget, string][] = [
			[{ kind: 'namespace' }, ''],
			[{ kind: 'hub', hubName: 'telemetry' }, '/telemetry'],
			[
				{ kind: 'group', hubName: 'telemetry', consumerGroup: '$Default' },
				'/telemetry/consumergroups/%24Default',
			],
			[
				{
					kind: 'partition',
					hubName: 'telemetry',
					consumerGroup: '$Default',
					partitionId: '01',
				},
				'/telemetry/consumergroups/%24Default/partitions/01',
			],
		]
		for (const [target, path] of targets)
			expect(
				eventHubUrl('fixture.servicebus.windows.net', {
					id: randomUUID(),
					connectionId: randomUUID(),
					scheme,
					target,
				}),
			).toBe(`${scheme}://fixture.servicebus.windows.net${path}`)
	},
)
it('rejects arbitrary clipboard text, malformed URL scopes, hosts, schemes and credentials', () => {
	const value = {
		id: randomUUID(),
		connectionId: randomUUID(),
		scheme: 'https',
		target: { kind: 'hub', hubName: 'telemetry' },
	}
	for (const bad of [
		{ ...value, text: 'secret' },
		{ ...value, scheme: 'file' },
		{ ...value, target: { ...value.target, hubName: '../other' } },
		{ ...value, target: { kind: 'namespace', hubName: 'other' } },
		{
			...value,
			target: {
				kind: 'partition',
				hubName: 'telemetry',
				consumerGroup: '$Default',
				partitionId: '../0',
			},
		},
	])
		expect(eventHubCopyUrlSchema.safeParse(bad).success).toBe(false)
	expect(() =>
		eventHubUrl('fixture.servicebus.windows.net@evil.test', eventHubCopyUrlSchema.parse(value)),
	).toThrow()
})
it('refreshes exact partition metadata without opening readers and labels empty partitions', async () => {
	await start()
	const value = await host.request('eh.statistics', { ...request(), hubName: 'telemetry' })
	expect(value.partitions).toHaveLength(2)
	expect(value.partitions[0].metadata).toMatchObject({
		beginningSequence: '9007199254740993',
		lastSequence: '9007199254740995',
		lastOffset: 'offset:three',
	})
	expect(value.partitions[1].metadata).toMatchObject({
		isEmpty: true,
		beginningSequence: null,
		lastSequence: null,
	})
	expect(Date.parse(value.capturedAt)).toBeGreaterThanOrEqual(Date.parse(value.startedAt))
	expect(JSON.stringify(value)).not.toMatch(/SharedAccessKey|SECRET/)
	expect((await read()).received).toBe(3)
})
it('keeps partial metadata failures distinct from empty streams and supports send-only metadata', async () => {
	await start('send')
	const value = await host.request('eh.statistics', { ...request(), hubName: 'stats-partial' })
	expect(value.partitions[0].metadata).not.toBeNull()
	expect(value.partitions[1]).toMatchObject({
		partitionId: '1',
		metadata: null,
		error: expect.stringContaining('unavailable'),
	})
	expect(JSON.stringify(value)).not.toContain('SECRET')
})
it('bounds partition discovery and cancels a refresh without poisoning later reads', async () => {
	await start()
	const full = await host.request('eh.statistics', { ...request(), hubName: 'listen-1024' })
	expect(full.partitions).toHaveLength(1024)
	expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(524288)
	const controller = new AbortController()
	const pending = host.request(
		'eh.statistics',
		{ ...request(), hubName: 'stats-slow' },
		{ signal: controller.signal },
	)
	setTimeout(() => controller.abort(), 100)
	await expect(pending).rejects.toThrow()
	expect((await read()).received).toBe(3)
	await expect(
		host.request('eh.statistics', {
			id: randomUUID(),
			connectionId: randomUUID(),
			hubName: 'telemetry',
		}),
	).rejects.toThrow('expired')
})
it('preserves per-read successful timings, body sizes and immutable recovery', async () => {
	await start()
	const value = await read()
	const bytes = value.items.reduce((sum, row) => sum + row.bodySize, 0)
	expect(value.statistics).toMatchObject({
		successfulCalls: 3,
		failedCalls: 0,
		emptyCalls: 0,
		bodyEvents: 3,
		bodyBytes: bytes,
		minBodyBytes: 4,
	})
	expect(value.statistics!.maxBodyBytes).toBe(Math.max(...value.items.map((row) => row.bodySize)))
	expect(value.statistics!.totalCallMs).toBeGreaterThanOrEqual(value.statistics!.maxCallMs!)
	expect(
		await host.request('eh.read.result', { ...request(), operationId: value.operationId }),
	).toEqual(value)
	const failed = await read('fail')
	expect(failed.statistics).toMatchObject({ successfulCalls: 1, failedCalls: 1, bodyEvents: 1 })
})
it('reports idle waits and cancelled calls without fabricated event rates or timing samples', async () => {
	await start()
	const idle = await host.request('eh.read', {
		...request(),
		hubName: 'telemetry',
		consumerGroup: '$Default',
		partitionId: '1',
		position: { kind: 'earliest' },
		maxEvents: 3,
		maxSeconds: 1,
	})
	expect(idle.statistics).toMatchObject({
		bodyEvents: 0,
		bodyBytes: 0,
		minBodyBytes: null,
		maxBodyBytes: null,
	})
	expect(idle.statistics!.successfulCalls + idle.statistics!.failedCalls).toBeGreaterThan(0)
	const slow = await read('slow')
	expect(slow.statistics).toMatchObject({
		successfulCalls: 0,
		failedCalls: 1,
		minCallMs: null,
		maxCallMs: null,
		totalCallMs: 0,
	})
})
it('aggregates all-partition statistics once and emits them in progress and recovery', async () => {
	await start()
	const seen: unknown[] = []
	host.on('event', (e) => {
		if (e.type === 'event-hub-listen-progress') seen.push(e)
	})
	const value = await host.request('eh.listen', {
		...request(),
		hubName: 'listen-normal',
		consumerGroup: '$Default',
		start: { kind: 'earliest' },
		concurrency: 2,
		maxEvents: 9,
		maxSeconds: 5,
		acknowledged: true,
	})
	expect(value.statistics).toMatchObject({
		bodyEvents: 9,
		bodyBytes: value.partitions.reduce((sum, p) => sum + p.bytes, 0),
	})
	expect(value.statistics!.successfulCalls - value.statistics!.emptyCalls).toBe(9)
	expect(seen.at(-1)).toMatchObject({ statistics: value.statistics, phase: 'finished' })
	expect(
		await host.request('eh.listen.result', { ...request(), operationId: value.operationId }),
	).toEqual(value)
})
it('counts only confirmed send bodies and successful batch timings; uncertain acceptance stays excluded', async () => {
	await start()
	const input = (hubName: string) => ({
		...request(),
		hubName,
		drafts: [{ bodyBase64: 'aGVsbG8=', contentType: '', correlationId: '', properties: [] }],
		routing: { kind: 'automatic' as const },
		repetitions: 3,
		batchSize: 2,
		delayMs: 0,
		maxSeconds: 5,
		acknowledged: true as const,
	})
	const value = await host.request('eh.send', input('send-normal'))
	expect(value.statistics).toMatchObject({
		bodyEvents: 3,
		bodyBytes: 15,
		minBodyBytes: 5,
		maxBodyBytes: 5,
		successfulCalls: 2,
		failedCalls: 0,
	})
	expect(
		await host.request('eh.send.result', { ...request(), operationId: value.operationId }),
	).toEqual(value)
	const uncertain = await host.request('eh.send', input('send-unknown'))
	expect(uncertain.uncertain).toBeGreaterThan(0)
	expect(uncertain.statistics).toMatchObject({
		bodyEvents: uncertain.confirmed,
		bodyBytes: uncertain.confirmed * 5,
		failedCalls: 1,
	})
})
it('supports the IoT built-in metadata snapshot and rejects another hub', async () => {
	await start('read', 'iot-hub')
	expect(
		(await host.request('eh.statistics', { ...request(), hubName: 'telemetry' })).partitions,
	).toHaveLength(2)
	await expect(host.request('eh.statistics', { ...request(), hubName: 'other' })).rejects.toThrow(
		'EntityPath',
	)
})
