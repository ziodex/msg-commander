import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { EventGridController } from '../../src/main/features/event-grid/controller'
import {
	eventGridReceiveSchema,
	eventGridSettleSchema,
	type EventGridReceive,
	type EventGridSettle,
} from '../../src/shared/contracts/event-grid/pulling'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
const target = {
	kind: 'subscription',
	topicName: 'orders',
	subscriptionName: 'fulfillment',
} as const
let host: Backend,
	connectionId: string = randomUUID()
const profile = () => ({
	id: randomUUID(),
	name: 'Grid',
	service: 'event-grid' as const,
	namespace: 'fixture.westeurope-1.eventgrid.azure.net',
	auth: 'device-code' as const,
	tenantId: 'fixture',
	clientId: randomUUID(),
	rememberSecret: false,
})
async function start(tenantId = 'fixture') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const p = profile()
	connectionId = (
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile: p,
			management: { resourceId, tenantId, clientId: p.clientId },
		})
	).connectionId
}
const request = () => ({ id: randomUUID(), connectionId })
const receive = (): EventGridReceive => ({
	...request(),
	target,
	maxEvents: 3,
	batchSize: 2,
	maxWaitSeconds: 10,
	maxSeconds: 60,
	acknowledged: true,
})
const settle = (
	handles: string[],
	action: EventGridSettle['action'] = 'acknowledge',
): EventGridSettle => ({
	...request(),
	target,
	handles,
	action,
	releaseDelaySeconds: 0,
	acknowledged: true,
})
afterEach(async () => {
	await host?.stop()
})
it('exercises production pull transport, bounded receiving, token isolation, settlement, locks, partial outcomes and cancellation', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-grid-receive-checks'], { encoding: 'utf8' }),
	).toContain('Event Grid receiving adapter checks passed (57 assertions)')
})
it('strictly validates receive bounds and opaque settlement handles', () => {
	const value = receive()
	expect(eventGridReceiveSchema.safeParse(value).success).toBe(true)
	for (const invalid of [
		{ maxEvents: 101 },
		{ batchSize: 11 },
		{ maxWaitSeconds: 0 },
		{ maxWaitSeconds: 121 },
		{ maxSeconds: 301 },
		{ acknowledged: false },
		{ endpoint: 'https://evil.invalid' },
		{ target: { kind: 'topic', topicName: 'orders', subscriptionName: null } },
	])
		expect(eventGridReceiveSchema.safeParse({ ...value, ...invalid }).success).toBe(false)
	const p = settle([randomUUID()])
	expect(eventGridSettleSchema.safeParse(p).success).toBe(true)
	for (const invalid of [
		{ handles: [] },
		{ handles: [p.handles[0], p.handles[0]] },
		{ handles: ['raw-lock-token'] },
		{ action: 'delete' },
		{ releaseDelaySeconds: 10 },
		{ acknowledged: false },
		{ lockTokens: ['secret'] },
	])
		expect(eventGridSettleSchema.safeParse({ ...p, ...invalid }).success).toBe(false)
	expect(
		eventGridSettleSchema.safeParse({ ...p, action: 'release', releaseDelaySeconds: 3600 })
			.success,
	).toBe(true)
})
it('receives bounded events, inspects precise JSON and settles without exposing lock tokens', async () => {
	await start()
	const progress: unknown[] = []
	host.on('event', (e) => progress.push(e))
	const p = receive(),
		value = await host.request('eg.pull.receive', p)
	expect(value).toMatchObject({ status: 'completed', confirmed: 3, uncertain: 0 })
	const items = await host.request('eg.pull.list', { ...request(), target })
	expect(items).toHaveLength(3)
	const event = await host.request('eg.pull.inspect', {
		...request(),
		target,
		handle: items[0].handle,
	})
	expect(event.eventJson).toContain('9007199254740993')
	expect(JSON.stringify([value, items, event, progress])).not.toContain('SECRET-LOCK')
	expect(await host.request('eg.pull.receive', p)).toEqual(value)
	const done = await host.request('eg.pull.settle', settle([items[0].handle]))
	expect(done).toMatchObject({ confirmed: 1, failed: 0, status: 'completed' })
	expect((await host.request('eg.pull.list', { ...request(), target }))[0].state).toBe(
		'acknowledged',
	)
	expect(await host.request('eg.pull.clear', { ...request(), target })).toHaveLength(2)
})
it('renews, releases with delay, rejects, and refuses stale or unrelated handles', async () => {
	await start()
	const events = await host.request('eg.pull.receive', receive())
	expect(
		await host.request('eg.pull.settle', settle([events.handles[0]], 'renewLock')),
	).toMatchObject({ confirmed: 1 })
	expect(
		await host.request('eg.pull.settle', {
			...settle([events.handles[1]], 'release'),
			releaseDelaySeconds: 10,
		}),
	).toMatchObject({ confirmed: 1 })
	expect(
		await host.request('eg.pull.settle', settle([events.handles[2]], 'reject')),
	).toMatchObject({ confirmed: 1 })
	await expect(host.request('eg.pull.settle', settle([events.handles[2]]))).rejects.toThrow(
		/Only held/,
	)
	await expect(
		host.request('eg.pull.inspect', {
			...request(),
			target: { ...target, subscriptionName: 'audit' },
			handle: events.handles[0],
		}),
	).rejects.toThrow(/another subscription/)
	await expect(
		host.request('eg.pull.settle', {
			...settle([events.handles[0]]),
			acknowledged: false,
		} as unknown as EventGridSettle),
	).rejects.toThrow(/confirm/)
})
it('keeps immutable recoverable receipts for partial and uncertain settlements', async () => {
	await start('settle-partial')
	const events = await host.request('eg.pull.receive', receive()),
		p = settle(events.handles),
		value = await host.request('eg.pull.settle', p)
	expect(value).toMatchObject({ status: 'failed', confirmed: 2, failed: 1, uncertain: 0 })
	expect(value.results[0]).toMatchObject({ status: 'failed', errorCode: 'TokenLost' })
	expect(await host.request('eg.pull.result', { ...request(), operationId: p.id })).toEqual(value)
	expect(await host.request('eg.pull.settle', p)).toEqual(value)
	await expect(host.request('eg.pull.settle', { ...p, action: 'release' })).rejects.toThrow(
		/different inputs/,
	)
})
it('reports lost receive and settlement responses conservatively and never reuses uncertain handles', async () => {
	await start('settle-lost')
	const events = await host.request('eg.pull.receive', receive()),
		value = await host.request('eg.pull.settle', settle(events.handles))
	expect(value).toMatchObject({ status: 'unknown', confirmed: 0, uncertain: 3 })
	expect(
		(await host.request('eg.pull.list', { ...request(), target })).every(
			(e) => e.state === 'unknown',
		),
	).toBe(true)
	await expect(host.request('eg.pull.settle', settle(events.handles))).rejects.toThrow(
		/Only held/,
	)
	await host.stop()
	await start('pull-lost')
	expect(await host.request('eg.pull.receive', receive())).toMatchObject({
		status: 'unknown',
		confirmed: 0,
		uncertain: 2,
	})
})
it('waits for in-flight cancellation and enforces the independent receive deadline', async () => {
	await start('pull-slow')
	const cancellation = new AbortController(),
		p = receive()
	const pending = host.request('eg.pull.receive', p, {
		signal: cancellation.signal,
		waitForCancellation: true,
	})
	setTimeout(() => cancellation.abort(), 200)
	expect(await pending).toMatchObject({ status: 'unknown', reason: 'cancelled', uncertain: 2 })
	expect(await host.request('eg.pull.receive', { ...receive(), maxSeconds: 1 })).toMatchObject({
		status: 'unknown',
		reason: 'time',
		uncertain: 2,
	})
})
it('returns empty, Push and denied outcomes without inventing received events', async () => {
	await start('pull-empty')
	expect(await host.request('eg.pull.receive', receive())).toMatchObject({
		status: 'limited',
		reason: 'empty',
		confirmed: 0,
	})
	expect(
		await host.request('eg.pull.receive', {
			...receive(),
			target: { ...target, subscriptionName: 'audit' },
		}),
	).toMatchObject({ status: 'failed', uncertain: 0 })
	await host.stop()
	await start('pull-denied')
	expect(await host.request('eg.pull.receive', receive())).toMatchObject({
		status: 'failed',
		uncertain: 0,
	})
})
it('caps event inspection and connection snapshots and clears state on disconnect', async () => {
	await start('pull-large')
	const value = await host.request('eg.pull.receive', { ...receive(), maxEvents: 1 })
	const inspected = await host.request('eg.pull.inspect', {
		...request(),
		target,
		handle: value.handles[0],
	})
	expect(inspected.truncated).toBe(true)
	expect(inspected.eventJson.length).toBe(65536)
	await host.request('eg.pull.receive', { ...receive(), maxEvents: 99, batchSize: 10 })
	await expect(host.request('eg.pull.receive', receive())).rejects.toThrow(/100 event snapshots/)
	await host.request('eg.reset', {})
	await expect(
		host.request('eg.pull.result', { ...request(), operationId: value.operationId }),
	).rejects.toThrow(/expired/)
})
it('uses controller generation checks and named pull operations', async () => {
	await start()
	const controller = new EventGridController(host, () => {}),
		p = profile(),
		signal = new AbortController().signal
	const connected = await controller.connect(
		{
			id: randomUUID(),
			profileId: p.id,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		},
		{ ...p, secretState: 'none' },
		signal,
	)
	const value = await controller.receive(
		{ ...receive(), connectionId: connected.connectionId },
		signal,
	)
	expect(value.confirmed).toBe(3)
	await controller.reset()
	await expect(
		controller.received({ ...request(), connectionId: connected.connectionId, target }, signal),
	).rejects.toThrow(/Connect/)
})
