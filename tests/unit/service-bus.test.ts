import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { ServiceBusController } from '../../src/main/features/service-bus/controller'
import type { ProfileInput } from '../../src/shared/contracts'
import type { BodyChunk } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const profile: ProfileInput = {
	id: randomUUID(),
	name: 'Fixture',
	service: 'service-bus',
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas',
	tenantId: '',
	clientId: '',
	secret: 'fixture-only',
	rememberSecret: false,
}
let host: Backend
let connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
const target = (name = 'orders') => ({ kind: 'queue' as const, name })
const peek = (
	name = 'orders',
	fromSequenceNumber = '0',
	maxMessages = 10,
	subQueue: 'active' | 'dead-letter' = 'active',
	signal?: AbortSignal,
) =>
	host.request(
		'sb.peek',
		{ ...request(), target: target(name), subQueue, fromSequenceNumber, maxMessages },
		{ signal },
	)
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (await host.request('sb.connect', { operationId: randomUUID(), profile }))
		.connectionId
}
afterEach(async () => {
	await host?.stop()
})

it('production Azure adapter uses only explicit non-locking peeks for queues, sessions and subscription DLQs', () => {
	expect(execFileSync('dotnet', [dll, '--adapter-checks'], { encoding: 'utf8' })).toContain(
		'Adapter checks passed',
	)
})
it('browses pages, subscriptions and entity counts through the real framed host', async () => {
	await start()
	const page = await host.request('sb.list', { ...request(), kind: 'queue' })
	expect(page.items.map((i) => i.target.name)).toContain('orders')
	expect(
		(
			await host.request('sb.list', {
				...request(),
				kind: 'queue',
				continuationToken: page.continuationToken,
			})
		).items[0].target.name,
	).toBe('archive')
	expect(
		(await host.request('sb.list', { ...request(), kind: 'topic' })).items[0].target.kind,
	).toBe('topic')
	const subs = await host.request('sb.list', {
		...request(),
		kind: 'subscription',
		topicName: 'order-events',
	})
	expect(subs.items[0].target).toEqual({
		kind: 'subscription',
		name: 'billing',
		topicName: 'order-events',
	})
	expect(
		(await host.request('sb.entity', { ...request(), target: target() })).counts,
	).toMatchObject({ active: '2', deadLetter: '1', scheduled: null })
})
it('preserves exact sequence cursors, typed properties, binary bytes and dead-letter diagnostics', async () => {
	await start()
	const page = await peek('orders', '0', 1)
	expect(page.items[0].sequenceNumber).toBe('9007199254740993')
	expect(page.nextSequenceNumber).toBe('9007199254740994')
	const snapshotId = page.items[0].snapshotId!
	const details = await host.request('sb.inspect', { ...request(), snapshotId })
	expect(details.applicationProperties).toEqual(
		expect.arrayContaining([
			{ name: 'unsigned', type: 'uint64', value: '18446744073709551615' },
			{ name: 'binary', type: 'binary', value: 'AP8=' },
			{ name: 'duration', type: 'timespan', value: '00:01:30' },
		]),
	)
	const json = await host.request('sb.body', {
		...request(),
		snapshotId,
		offset: 0,
		count: 65536,
	})
	expect(Buffer.from(json.base64, 'base64').toString('utf8')).toContain('9007199254740993')
	const next = await peek('orders', page.nextSequenceNumber!, 1)
	expect(next.items[0].sequenceNumber).toBe('9007199254740996')
	const binary = await host.request('sb.body', {
		...request(),
		snapshotId: next.items[0].snapshotId!,
		offset: 0,
		count: 10,
	})
	expect([...Buffer.from(binary.base64, 'base64')]).toEqual([0, 255, 128, 65])
	await expect(host.request('sb.inspect', { ...request(), snapshotId })).rejects.toMatchObject({
		code: '-32013',
	})
	const dlq = await peek('orders', '0', 10, 'dead-letter')
	const dead = await host.request('sb.inspect', {
		...request(),
		snapshotId: dlq.items[0].snapshotId!,
	})
	expect(dead.systemProperties).toContainEqual({
		name: 'DeadLetterReason',
		type: 'string',
		value: 'ValidationFailed',
	})
	const session = await peek('sessions')
	expect(session.items[0].sessionId).toBe('session-001')
	const subscription = await host.request('sb.peek', {
		...request(),
		target: { kind: 'subscription', name: 'billing', topicName: 'order-events' },
		subQueue: 'dead-letter',
		fromSequenceNumber: '0',
		maxMessages: 1,
	})
	expect(subscription.items[0].messageId).toBe('dead-order')
})
it('reads a body larger than a preview window in exact bounded chunks', async () => {
	await start()
	const snapshotId = (await peek('large')).items[0].snapshotId!
	const chunks: Buffer[] = []
	let offset: number | null = 0
	while (offset !== null) {
		const chunk: BodyChunk = await host.request('sb.body', {
			...request(),
			snapshotId,
			offset,
			count: 65536,
		})
		expect(chunk.base64.length).toBeLessThanOrEqual(87384)
		chunks.push(Buffer.from(chunk.base64, 'base64'))
		offset = chunk.nextOffset
	}
	const bytes = Buffer.concat(chunks)
	expect(bytes.length).toBe(300000)
	expect(bytes.every((value, index) => value === index % 251)).toBe(true)
	await expect(
		host.request('sb.body', { ...request(), snapshotId, offset: 300001, count: 1 }),
	).rejects.toMatchObject({ code: '-32602' })
})
it('enforces the snapshot budget without skipping omitted messages or overflowing Int64', async () => {
	await start()
	const budget = await peek('budget')
	expect(budget.items).toHaveLength(1)
	expect(budget.nextSequenceNumber).toBe('2')
	expect(budget.warning).toContain('local page limit')
	expect((await peek('budget', budget.nextSequenceNumber!)).items[0].sequenceNumber).toBe('2')
	const oversized = await peek('oversized')
	expect(oversized.items[0].snapshotId).toBeNull()
	expect(oversized.items[0].inspectionWarning).toContain('64 MiB')
	expect((await peek('last-sequence')).nextSequenceNumber).toBeNull()
	const empty = await peek('empty', '9007199254740993')
	expect(empty.items).toHaveLength(0)
	expect(empty.nextSequenceNumber).toBe('9007199254740993')
})
it('cancellation preserves prior snapshots, errors redact SDK text, and reconnect expires handles', async () => {
	await start()
	const snapshotId = (await peek()).items[0].snapshotId!
	const controller = new AbortController()
	const pending = peek('slow', '0', 1, 'active', controller.signal)
	controller.abort()
	await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
	await expect(host.request('sb.inspect', { ...request(), snapshotId })).resolves.toHaveProperty(
		'summary',
	)
	await expect(peek('denied')).rejects.toMatchObject({
		code: '-32001',
		message: expect.stringContaining('Listen'),
	})
	await expect(
		host.request('sb.entity', { ...request(), target: target('deleted') }),
	).rejects.toMatchObject({
		code: '-32004',
		message: 'The namespace or entity no longer exists. Refresh the resource list.',
	})
	const previous = connectionId
	connectionId = (await host.request('sb.connect', { operationId: randomUUID(), profile }))
		.connectionId
	await expect(
		host.request('sb.list', { ...request(), connectionId: previous, kind: 'queue' }),
	).rejects.toMatchObject({ code: '-32010' })
	await expect(host.request('sb.inspect', { ...request(), snapshotId })).rejects.toMatchObject({
		code: '-32013',
	})
	await host.request('sb.disconnect', { connectionId })
	await expect(peek()).rejects.toMatchObject({ code: '-32010' })
})
it('the main-process controller rejects stale connections after profile edits and backend restarts', async () => {
	await start()
	let resets = 0
	const controller = new ServiceBusController(host, () => {
		resets++
	})
	const active = await controller.connect(randomUUID(), profile, new AbortController().signal)
	controller.require(active.connectionId)
	await controller.reset()
	expect(resets).toBe(1)
	expect(() => controller.require(active.connectionId)).toThrow('Connect to this namespace again')
	await expect(
		host.request('sb.list', { ...request(), connectionId: active.connectionId, kind: 'queue' }),
	).rejects.toMatchObject({ code: '-32010' })
	await host.restart()
	await expect(peek()).rejects.toMatchObject({ code: '-32010' })
})

it('pages namespace runtime counts and rejects expired connection handles without peeking or receiving', async () => {
	expect(execFileSync('dotnet', [dll, '--runtime-checks'], { encoding: 'utf8' })).toContain(
		'Runtime adapter checks passed',
	)
	await start()
	const queues = await host.request('sb.runtime', { ...request(), kind: 'queue' })
	expect(queues.items.find((row) => row.target.name === 'orders')?.counts.active).toBe('2')
	const next = await host.request('sb.runtime', {
		...request(),
		kind: 'queue',
		continuationToken: queues.continuationToken,
	})
	expect(next.items[0].target.name).toBe('archive')
	const topics = await host.request('sb.runtime', { ...request(), kind: 'topic' })
	expect(topics.items[0].counts.active).toBeNull()
	expect(topics.items[0].counts.scheduled).toBe('5')
	const subs = await host.request('sb.runtime', {
		...request(),
		kind: 'subscription',
		topicName: 'order-events',
	})
	expect(subs.items.map((row) => row.target.name)).toEqual(['billing', 'audit'])
	await host.request('sb.reset', {})
	await expect(host.request('sb.runtime', { ...request(), kind: 'queue' })).rejects.toMatchObject(
		{
			code: '-32010',
		},
	)
})
