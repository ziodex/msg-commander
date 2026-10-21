import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { EventHubsController } from '../../src/main/features/event-hubs/controller'
import {
	eventHubReadSchema,
	eventHubsConnectSchema,
	type EventHubRead,
	type EventPosition,
} from '../../src/shared/contracts/event-hubs/core'
import type { ProfileInput } from '../../src/shared/contracts'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const profile: ProfileInput = {
	id: randomUUID(),
	name: 'Events',
	service: 'event-hubs',
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas',
	tenantId: '',
	clientId: '',
	secret: 'offline',
	rememberSecret: false,
}
const management = {
	resourceId:
		'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture',
	tenantId: 'fixture',
	clientId: randomUUID(),
}
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
async function start(browse = false) {
	host = new Backend('dotnet', [dll])
	await host.start()
	const connected = await host.request('eh.connect', {
		operationId: randomUUID(),
		profile,
		hubName: browse ? '' : 'telemetry',
		management: browse ? management : null,
	})
	connectionId = connected.connectionId
	return connected
}
const input = (
	hubName = 'telemetry',
	position: EventPosition = { kind: 'earliest' },
): EventHubRead => ({
	...request(),
	hubName,
	consumerGroup: '$Default',
	partitionId: '0',
	position,
	maxEvents: 3,
	maxSeconds: 5,
})
const run = (value = input(), signal?: AbortSignal) =>
	host.request('eh.read', value, { signal, waitForCancellation: true, timeout: 15000 })
afterEach(async () => {
	await host?.stop()
})
it('maps SDK positions, reader options, exact metadata, SAS restrictions and ARM pages', () => {
	expect(execFileSync('dotnet', [dll, '--event-hubs-checks'], { encoding: 'utf8' })).toContain(
		'Event Hubs adapter checks passed',
	)
})
it('connects to a known hub without ARM and reports data-only browsing clearly', async () => {
	expect(await start()).toMatchObject({
		managementAvailable: false,
		initialHub: { name: 'telemetry', partitionIds: ['0', '1'] },
	})
	await expect(
		host.request('eh.list', {
			...request(),
			kind: 'hubs',
			hubName: '',
			continuationToken: null,
		}),
	).rejects.toThrow('separate Entra')
})
it('browses scoped opaque pages and maps empty and populated partition metadata', async () => {
	expect(await start(true)).toMatchObject({ managementAvailable: true, initialHub: null })
	const first = await host.request('eh.list', {
		...request(),
		kind: 'hubs',
		hubName: '',
		continuationToken: null,
	})
	expect(first.items[0]).toMatchObject({ name: 'telemetry', partitionCount: 2 })
	expect(first.continuationToken).toMatch(/^[0-9a-f-]{36}$/)
	expect(JSON.stringify(first)).not.toContain('management.azure.com')
	expect(
		(
			await host.request('eh.list', {
				...request(),
				kind: 'hubs',
				hubName: '',
				continuationToken: first.continuationToken,
			})
		).items[0].name,
	).toBe('archive')
	await expect(
		host.request('eh.list', {
			...request(),
			kind: 'groups',
			hubName: 'telemetry',
			continuationToken: first.continuationToken,
		}),
	).rejects.toThrow('another scope')
	const groups = await host.request('eh.list', {
		...request(),
		kind: 'groups',
		hubName: 'telemetry',
		continuationToken: null,
	})
	expect(groups.items.map((i) => i.name)).toEqual(['$Default', 'dashboard'])
	expect(
		(
			await host.request('eh.list', {
				...request(),
				kind: 'groups',
				hubName: 'telemetry',
				continuationToken: groups.continuationToken,
			})
		).items[0].name,
	).toBe('audit')
	expect(
		await host.request('eh.partition', {
			...request(),
			hubName: 'telemetry',
			partitionId: '0',
		}),
	).toMatchObject({
		isEmpty: false,
		beginningSequence: '9007199254740993',
		lastOffset: 'offset:three',
	})
	expect(
		await host.request('eh.partition', {
			...request(),
			hubName: 'telemetry',
			partitionId: '1',
		}),
	).toMatchObject({
		isEmpty: true,
		beginningSequence: null,
		lastSequence: null,
		lastOffset: null,
	})
})
it('keeps exact sequence strings, opaque offsets, typed properties and binary bodies without consuming events', async () => {
	await start()
	const result = await run()
	expect(result).toMatchObject({ received: 3, status: 'completed', reason: 'count' })
	expect(result.items.map((i) => i.sequenceNumber)).toEqual([
		'9007199254740993',
		'9007199254740994',
		'9007199254740995',
	])
	expect(result.items.map((i) => i.offset)).toEqual(['offset:one', 'offset:two', 'offset:three'])
	const details = await host.request('eh.inspect', {
		...request(),
		snapshotId: result.items[0].snapshotId!,
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'unsigned',
		type: 'uint64',
		value: '18446744073709551615',
	})
	const chunk = await host.request('eh.body', {
		...request(),
		snapshotId: result.items[1].snapshotId!,
		offset: 0,
		count: 65536,
	})
	expect(Buffer.from(chunk.base64, 'base64')).toEqual(Buffer.from([0, 255, 128, 65]))
	expect((await run()).received).toBe(3)
	await expect(
		host.request('eh.inspect', { ...request(), snapshotId: result.items[0].snapshotId! }),
	).rejects.toThrow('expired')
})
it('uses explicit sequence, offset and enqueued time positions with inclusivity', async () => {
	await start()
	for (const position of [
		{ kind: 'sequence', value: '9007199254740993', inclusive: false },
		{ kind: 'sequence', value: '9007199254740994', inclusive: true },
		{ kind: 'offset', value: 'offset:one', inclusive: false },
		{ kind: 'offset', value: 'offset:two', inclusive: true },
		{ kind: 'time', value: '2026-10-11T12:00:01+02:00' },
	] satisfies EventPosition[]) {
		const result = await run({ ...input('telemetry', position), maxEvents: 1 })
		expect(
			result.items[0]?.sequenceNumber,
			JSON.stringify(position) + ' ' + result.summary,
		).toBe('9007199254740994')
		expect(result.position).toEqual(position)
	}
})
it('waits through an idle latest position until the time bound, without claiming emptiness', async () => {
	await start()
	const result = await run({ ...input('telemetry', { kind: 'latest' }), maxSeconds: 1 })
	expect(result).toMatchObject({ received: 0, status: 'limited', reason: 'time' })
	expect(result.elapsedMs).toBeGreaterThanOrEqual(900)
	expect(result.summary).toContain('does not prove the partition is empty')
})
it('cancels a running read and retains late events and the partial result', async () => {
	await start()
	const value = input('late'),
		stop = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'event-hub-read-progress' &&
			e.operationId === value.id &&
			e.phase === 'opening'
		)
			setTimeout(() => stop.abort(), 100)
	})
	const result = await run(value, stop.signal)
	expect(result).toMatchObject({ status: 'cancelled', reason: 'cancelled', received: 1 })
	expect(await host.request('eh.read.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	expect(
		(
			await host.request('eh.body', {
				...request(),
				snapshotId: result.items[0].snapshotId!,
				offset: 0,
				count: 65536,
			})
		).totalBytes,
	).toBeGreaterThan(0)
})
it('returns an idle cancellation receipt and clears snapshots and receipts on reset', async () => {
	await start()
	const value = input('slow'),
		stop = new AbortController()
	host.on('event', (e) => {
		if (
			e.type === 'event-hub-read-progress' &&
			e.operationId === value.id &&
			e.phase === 'opening'
		)
			setTimeout(() => stop.abort(), 100)
	})
	expect(await run(value, stop.signal)).toMatchObject({ status: 'cancelled', received: 0 })
	await host.request('eh.reset', {})
	await expect(
		host.request('eh.read.result', { ...request(), operationId: value.id }),
	).rejects.toThrow('expired')
})
it('retains failed read counts and sanitizes errors without retries', async () => {
	await start()
	const result = await run(input('fail'))
	expect(result).toMatchObject({ status: 'failed', received: 1, reason: 'error' })
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(result.items[0].snapshotId).toBeTruthy()
	expect(await run(input('over-batch'))).toMatchObject({ status: 'failed', received: 0 })
})
it('blocks another read after cleanup failure while allowing inspection and receipt recovery', async () => {
	await start()
	const result = await run(input('cleanup'))
	expect(result).toMatchObject({ status: 'failed', received: 3 })
	expect(result.cleanupWarning).toContain('Disconnect')
	await expect(run()).rejects.toThrow('cleanup')
	expect(
		(
			await host.request('eh.inspect', {
				...request(),
				snapshotId: result.items[0].snapshotId!,
			})
		).summary.sequenceNumber,
	).toBe('9007199254740993')
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
it('pages large bodies, bounds metadata and stops at the 64 MiB body budget', async () => {
	await start()
	const large = await run({ ...input('large'), maxEvents: 1 })
	const body = await host.request('eh.body', {
		...request(),
		snapshotId: large.items[0].snapshotId!,
		offset: 0,
		count: 65536,
	})
	expect(body).toMatchObject({ totalBytes: 70000, nextOffset: 65536 })
	const tail = await host.request('eh.body', {
		...request(),
		snapshotId: large.items[0].snapshotId!,
		offset: 65536,
		count: 65536,
	})
	expect(tail.nextOffset).toBeNull()
	expect(Buffer.from(tail.base64, 'base64').length).toBe(4464)
	const metadata = await run({ ...input('metadata'), maxEvents: 1 })
	const details = await host.request('eh.inspect', {
		...request(),
		snapshotId: metadata.items[0].snapshotId!,
	})
	expect(details.warning).toContain('truncated')
	expect(details.applicationProperties.length).toBeLessThanOrEqual(64)
	expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(66000)
	const budget = await run(input('budget'))
	expect(budget).toMatchObject({ status: 'limited', reason: 'buffer-limit', received: 2 })
	expect(budget.items[0].snapshotId).toBeTruthy()
	expect(budget.items[1].snapshotId).toBeNull()
})
it('rejects invalid positions, names and bounds on both request boundaries', async () => {
	await start()
	const valid = input()
	const invalid = [
		{ maxEvents: 0 },
		{ maxEvents: 101 },
		{ maxSeconds: 301 },
		{ maxSeconds: 0 },
		{ consumerGroup: '../escape' },
		{ partitionId: 'x' },
		{ hubName: '../escape' },
		{ position: { kind: 'earliest', inclusive: true } },
		{ position: { kind: 'sequence', value: '9223372036854775808', inclusive: true } },
		{ position: { kind: 'offset', value: 'bad offset', inclusive: false } },
		{ position: { kind: 'time', value: '2026-10-11T10:00:00' } },
	]
	for (const change of invalid) {
		const value = { ...valid, ...change, id: randomUUID() }
		expect(eventHubReadSchema.safeParse(value).success).toBe(false)
		await expect(run(value as EventHubRead)).rejects.toThrow()
	}
	expect(
		eventHubsConnectSchema.safeParse({
			id: randomUUID(),
			profileId: profile.id,
			hubName: '',
			management: null,
		}).success,
	).toBe(false)
})
it('retains idempotent read receipts and rejects changed parameters and stale connections', async () => {
	await start()
	const value = { ...input(), maxEvents: 1 },
		first = await run(value)
	expect(await run(value)).toEqual(first)
	await expect(run({ ...value, maxEvents: 2 })).rejects.toThrow('another request')
	await expect(run({ ...input(), connectionId: randomUUID() })).rejects.toThrow('expired')
	expect(
		await host.request('eh.read.result', { ...request(), operationId: randomUUID() }),
	).toBeNull()
})
it('expires main-process connections on reset and prevents cancelled sign-in from becoming active', async () => {
	await start()
	let resets = 0
	const controller = new EventHubsController(host, () => resets++)
	const setup = {
		id: randomUUID(),
		profileId: profile.id,
		hubName: 'telemetry',
		management: null,
	}
	const active = await controller.connect(setup, profile, new AbortController().signal)
	controller.require(active.connectionId)
	await controller.reset()
	expect(resets).toBe(1)
	expect(() => controller.require(active.connectionId)).toThrow('again')
	const stop = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'device-code') stop.abort()
	})
	await expect(
		controller.connect(
			{ ...setup, id: randomUUID() },
			{ ...profile, auth: 'device-code', tenantId: 'slow' },
			stop.signal,
		),
	).rejects.toThrow()
	const next = await controller.connect(
		{ ...setup, id: randomUUID() },
		profile,
		new AbortController().signal,
	)
	controller.require(next.connectionId)
	controller.forget()
	expect(() => controller.require(next.connectionId)).toThrow('again')
})
it('keeps Service Bus usable while the Event Hubs workspace is connected', async () => {
	await start()
	const sb = await host.request('sb.connect', {
		operationId: randomUUID(),
		profile: { ...profile, service: 'service-bus' },
	})
	await run()
	await host.request('eh.reset', {})
	expect(
		(
			await host.request('sb.list', {
				id: randomUUID(),
				connectionId: sb.connectionId,
				kind: 'queue',
			})
		).items[0].target.name,
	).toBe('orders')
})
it('bounds retained receipts and resets their capacity with a new connection', async () => {
	await start()
	for (let i = 0; i < 100; i++) await run({ ...input(), maxEvents: 1 })
	await expect(run()).rejects.toThrow('receipt limit')
	connectionId = (
		await host.request('eh.connect', {
			operationId: randomUUID(),
			profile,
			hubName: 'telemetry',
			management: null,
		})
	).connectionId
	expect((await run()).received).toBe(3)
})
it('rejects body ranges and forged management cursors without echoing secrets', async () => {
	await start(true)
	await expect(
		host.request('eh.list', {
			...request(),
			kind: 'hubs',
			hubName: '',
			continuationToken: randomUUID(),
		}),
	).rejects.toThrow('expired')
	const result = await run()
	for (const range of [
		{ offset: -1, count: 1 },
		{ offset: 99999, count: 1 },
		{ offset: 0, count: 65537 },
	]) {
		await expect(
			host.request('eh.body', {
				...request(),
				snapshotId: result.items[0].snapshotId!,
				...range,
			}),
		).rejects.toThrow('range')
	}
	await expect(host.request('eh.hub', { ...request(), hubName: 'denied' })).rejects.toThrow(
		'access denied',
	)
})
it('routes re-authentication codes to the current operation instead of the completed connection job', async () => {
	await start()
	const codes: string[] = []
	host.on('event', (e) => {
		if (e.type === 'device-code') codes.push(e.operationId)
	})
	const value = { ...request(), hubName: 'reauth' }
	await host.request('eh.hub', value)
	expect(codes).toEqual([value.id])
})
