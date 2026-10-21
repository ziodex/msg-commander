import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	testJobRequestSchema,
	type TestJobRequest,
	type TestJobProgress,
} from '../../src/shared/contracts/service-bus/test-jobs'
import type { EntityTarget, PeekTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const target: PeekTarget = { kind: 'queue', name: 'empty' }
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
				namespace: 'fixture.servicebus.windows.net',
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
	mode: 'send' | 'receive' = 'send',
	destination: EntityTarget = target,
): TestJobRequest {
	return {
		...request(),
		target: destination,
		mode,
		maxMessages: 3,
		maxSeconds: 10,
		delayMs: 0,
		workers: 1,
		batchSize: 1,
		generator: { kind: 'literal', seed: 1, sizeBytes: 1024 },
		settlement: 'complete',
		deadLetterReason: '',
		deadLetterDescription: '',
		sessionId: '',
		body: mode === 'send' ? '{"test":true}' : '',
		contentType: mode === 'send' ? 'application/json' : '',
		acknowledged: true,
	}
}
const run = (value = input(), signal?: AbortSignal) =>
	host.request('sb.test.run', value, { signal, waitForCancellation: true, timeout: 15000 })
const peek = (destination: PeekTarget = target, subQueue: 'active' | 'dead-letter' = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: destination,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
const seed = (
	messageId: string,
	destination: PeekTarget = target,
	sessionId = '',
	subQueue = 'active',
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
			properties: [{ name: 'fixture-subqueue', type: 'string', value: subQueue }],
		},
	})
afterEach(async () => {
	await host?.stop()
})
it('reuses the SDK sender, preflights size, routes topics and disposes once', () => {
	expect(execFileSync('dotnet', [dll, '--test-job-checks'], { encoding: 'utf8' })).toContain(
		'Test job adapter checks passed',
	)
})
it('rejects invalid scope and limits at both boundaries before sending', async () => {
	await start()
	const good = input()
	for (const change of [
		{ maxMessages: 0 },
		{ maxMessages: 100001 },
		{ maxSeconds: 0 },
		{ maxSeconds: 601 },
		{ delayMs: -1 },
		{ delayMs: 1001 },
		{ workers: 0 },
		{ workers: 9 },
		{ batchSize: 0 },
		{ batchSize: 101 },
		{ acknowledged: false },
		{ body: 'x'.repeat(65537) },
		{ sessionId: 'x'.repeat(129) },
		{ contentType: 'x'.repeat(129) },
		{ mode: 'invalid' },
		{ mode: 'receive' },
		{ target: { kind: 'subscription', name: 'billing', topicName: 'order-events' } },
		{ subQueue: 'dead-letter' },
	]) {
		const bad = { ...good, ...change }
		expect(testJobRequestSchema.safeParse(bad).success).toBe(false)
		await expect(run(bad as TestJobRequest)).rejects.toThrow()
	}
	await expect(run(input('receive', { kind: 'topic', name: 'order-events' }))).rejects.toThrow(
		'compatible target',
	)
	expect((await peek()).items).toHaveLength(0)
})
it('sends exact counts and metadata, reports monotonic progress, and recovers without replaying', async () => {
	await start()
	const events: TestJobProgress[] = [],
		value = { ...input(), maxMessages: 4, delayMs: 100 }
	host.on('event', (event) => {
		if (event.type === 'test-job-progress') events.push(event)
	})
	const result = await run(value)
	expect(result).toMatchObject({
		status: 'completed',
		reason: 'message-limit',
		sent: 4,
		completed: 0,
		uncertain: 0,
		lastMessageId: `${value.id}-4`,
	})
	expect(result.elapsedMs).toBeGreaterThanOrEqual(290)
	const messages = (await peek()).items
	expect(messages.map((m) => m.messageId)).toEqual([1, 2, 3, 4].map((i) => `${value.id}-${i}`))
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: messages[0].snapshotId!,
	})
	expect(details.applicationProperties).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: 'commander-test-job', value: value.id }),
			expect.objectContaining({ name: 'commander-test-index', value: '1' }),
		]),
	)
	expect(events[0].phase).toBe('opening')
	expect(events.at(-1)).toMatchObject({ phase: 'finished', sent: 4 })
	expect(events.every((e, i) => !i || e.sent >= events[i - 1].sent)).toBe(true)
	expect(await run(value)).toEqual(result)
	await expect(run({ ...value, maxMessages: 5 })).rejects.toThrow('different request')
	expect(await host.request('sb.test.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	expect((await peek()).items).toHaveLength(4)
})
it('sends to topics and completes exactly the subscription count, leaving DLQ messages alone', async () => {
	await start()
	const topic: EntityTarget = { kind: 'topic', name: 'order-events' },
		subscription: PeekTarget = {
			kind: 'subscription',
			name: 'billing',
			topicName: 'order-events',
		}
	await run(input('send', topic))
	await seed('dead', subscription, '', 'dead-letter')
	const received = await run({ ...input('receive', subscription), maxMessages: 2 })
	expect(received).toMatchObject({
		status: 'completed',
		received: 2,
		completed: 2,
		sent: 0,
		uncertain: 0,
	})
	expect(BigInt(received.lastSequenceNumber!)).toBeGreaterThan(9007199254740991n)
	expect((await peek(subscription)).items).toHaveLength(1)
	expect((await peek(subscription, 'dead-letter')).items.map((m) => m.messageId)).toEqual([
		'dead',
	])
})
it('validates sessions and receives only the selected session', async () => {
	await start()
	const sessions: PeekTarget = { kind: 'queue', name: 'sessions' }
	expect(await run(input('send', sessions))).toMatchObject({ status: 'failed', sent: 0 })
	await run({ ...input('send', sessions), sessionId: 'one', maxMessages: 2 })
	await run({ ...input('send', sessions), sessionId: 'two', maxMessages: 1 })
	expect(await run(input('receive', sessions))).toMatchObject({ status: 'failed', completed: 0 })
	expect(await run({ ...input('receive'), sessionId: 'wrong' })).toMatchObject({
		status: 'failed',
		received: 0,
	})
	expect(
		await run({ ...input('receive', sessions), sessionId: 'one', maxMessages: 2 }),
	).toMatchObject({ status: 'completed', completed: 2, sessionId: 'one' })
	expect((await peek(sessions)).items.map((m) => m.sessionId)).toEqual(['two'])
})
it('waits through idle receives until the time limit without reporting an empty queue', async () => {
	await start()
	const result = await run({ ...input('receive'), maxSeconds: 1 })
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'time-limit',
		completed: 0,
		uncertain: 0,
	})
	expect(result.elapsedMs).toBeGreaterThanOrEqual(950)
	expect(result.elapsedMs).toBeLessThan(2500)
})
it('applies the time bound while pacing and preserves confirmed sends', async () => {
	await start()
	expect(await run({ ...input(), maxSeconds: 1, delayMs: 1000 })).toMatchObject({
		status: 'limited',
		reason: 'time-limit',
		sent: 1,
		uncertain: 0,
	})
	expect((await peek()).items).toHaveLength(1)
})
it('cancels between writes and retains a partial receipt', async () => {
	await start()
	const controller = new AbortController(),
		value = { ...input(), maxMessages: 1000, delayMs: 500 }
	host.on('event', (e) => {
		if (e.type === 'test-job-progress' && e.operationId === value.id && e.sent >= 1)
			controller.abort()
	})
	const result = await run(value, controller.signal)
	expect(result).toMatchObject({ status: 'cancelled', reason: 'cancelled', uncertain: 0 })
	expect(result.sent).toBeGreaterThanOrEqual(1)
	expect(result.sent).toBeLessThan(1000)
	expect((await peek()).items).toHaveLength(result.sent)
	expect(await host.request('sb.test.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
})
it('cancels idle PeekLock receives without reporting an uncertain deletion', async () => {
	await start()
	const controller = new AbortController(),
		value = input('receive', { kind: 'queue', name: 'slow' })
	host.on('event', (e) => {
		if (e.type === 'test-job-progress' && e.operationId === value.id && e.phase === 'opening')
			setTimeout(() => controller.abort(), 100)
	})
	expect(await run(value, controller.signal)).toMatchObject({
		status: 'cancelled',
		completed: 0,
		uncertain: 0,
	})
})
it('distinguishes preflight rejection, rejected sends and lost acknowledgements without retries or secrets', async () => {
	await start()
	for (const [name, status, uncertain] of [
		['test-preflight-fail', 'failed', 0],
		['resend-reject-send', 'failed', 0],
		['resend-unknown-send', 'unknown', 1],
	] as const) {
		const result = await run(input('send', { kind: 'queue', name }))
		expect(result).toMatchObject({ status, sent: 0, uncertain })
		expect(JSON.stringify(result)).not.toContain('SECRET')
		if (uncertain) expect((await peek({ kind: 'queue', name })).items).toHaveLength(1)
	}
})
it.each([
	['busy', 'busy or throttling'],
	['timeout', 'before the timeout'],
	['quota', 'quota was exceeded'],
	['connection', 'connection was interrupted'],
])(
	'describes a %s failure without SDK secrets, false confirmation or retries',
	async (kind, message) => {
		await start()
		const value = input('send', { kind: 'queue', name: `test-failure-${kind}` })
		const result = await run(value)
		expect(result).toMatchObject({ status: 'unknown', sent: 0, uncertain: 1 })
		expect(result.summary).toContain(message)
		expect(JSON.stringify(result)).not.toContain('SECRET')
		expect(await run(value)).toEqual(result)
	},
)
it('retains late acknowledged sends and marks cancelled in-flight sends uncertain', async () => {
	await start()
	for (const [name, status, sent, uncertain] of [
		['resend-commit-late', 'completed', 1, 0],
		['resend-slow-send', 'unknown', 0, 1],
	] as const) {
		const controller = new AbortController(),
			value = { ...input('send', { kind: 'queue', name }), maxMessages: 1 }
		const listener = (e: TestJobProgress) => {
			if (
				e.type === 'test-job-progress' &&
				e.operationId === value.id &&
				e.phase === 'opening'
			)
				setTimeout(() => controller.abort(), 70)
		}
		host.on('event', listener)
		expect(await run(value, controller.signal)).toMatchObject({ status, sent, uncertain })
		host.off('event', listener)
	}
})
it('distinguishes rejected, lost and timed-out completions with exact confirmed counts', async () => {
	await start()
	for (const [name, status, uncertain] of [
		['purge-reject-complete', 'failed', 0],
		['unknown-complete', 'unknown', 1],
		['purge-wait-complete', 'unknown', 1],
	] as const) {
		const destination: PeekTarget = { kind: 'queue', name }
		await seed(name, destination)
		const result = await run({ ...input('receive', destination), maxSeconds: 1 })
		expect(result).toMatchObject({ status, received: 1, completed: 0, uncertain })
		expect(JSON.stringify(result)).not.toContain('SECRET')
		expect((await peek(destination)).items).toHaveLength(name === 'unknown-complete' ? 0 : 1)
	}
})
it('retains completion acknowledged after cancellation and does not issue another receive', async () => {
	await start()
	await seed('purge-commit-late')
	await seed('untouched')
	const controller = new AbortController(),
		value = input('receive')
	host.on('event', (e) => {
		if (e.type === 'test-job-progress' && e.operationId === value.id && e.phase === 'opening')
			setTimeout(() => controller.abort(), 70)
	})
	expect(await run(value, controller.signal)).toMatchObject({
		status: 'cancelled',
		received: 1,
		completed: 1,
		uncertain: 0,
	})
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['untouched'])
})
it('reports cleanup failure without losing acknowledged counts', async () => {
	await start()
	const result = await run(input('send', { kind: 'queue', name: 'test-sender-cleanup-fail' }))
	expect(result).toMatchObject({ status: 'failed', sent: 3, uncertain: 0 })
	expect(result.cleanupWarning).toContain('cleanup')
})
it('blocks jobs while an interactive receiver is held and rejects stale connections', async () => {
	await start()
	await seed('held')
	await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		maxMessages: 1,
		waitSeconds: 1,
		sessionId: '',
	})
	await expect(run()).rejects.toThrow('Close the current')
	await expect(run({ ...input(), connectionId: randomUUID() })).rejects.toThrow(
		'Connection expired',
	)
})
it('keeps only bounded receipts and clears them on namespace reset', async () => {
	await start()
	const first = { ...input(), maxMessages: 1 }
	await run(first)
	for (let i = 1; i < 100; i++) await run({ ...input(), maxMessages: 1 })
	await expect(run()).rejects.toThrow('receipt limit')
	await host.request('sb.reset', {})
	await expect(
		host.request('sb.test.result', { ...request(), operationId: first.id }),
	).rejects.toThrow('Connection expired')
})

it('never completes a message returned after cancellation', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'test-receive-late' }
	await seed('untouched', destination)
	const controller = new AbortController(),
		value = input('receive', destination)
	host.on('event', (e) => {
		if (e.type === 'test-job-progress' && e.operationId === value.id && e.phase === 'opening')
			setTimeout(() => controller.abort(), 70)
	})
	expect(await run(value, controller.signal)).toMatchObject({
		status: 'cancelled',
		received: 1,
		completed: 0,
		uncertain: 0,
	})
	expect((await peek(destination)).items.map((m) => m.messageId)).toEqual(['untouched'])
})
it('requires an active listener to stop before starting a test job', async () => {
	await start()
	const listener = await host.request('sb.listener.start', {
		...request(),
		target,
		mode: 'manual',
		sessionId: '',
		maxMessages: 1000,
		maxSeconds: 30,
		maxLockSeconds: 10,
	})
	await expect(run()).rejects.toThrow('Stop the listener')
	await host.request('sb.listener.stop', { ...request(), listenerId: listener.listenerId })
	expect(await run()).toMatchObject({ status: 'completed', sent: 3 })
})

it('shares a non-divisible send count across workers, batches and exact unique indexes', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'test-concurrent' }
	const value = { ...input('send', destination), workers: 4, batchSize: 3, maxMessages: 23 }
	const progress: TestJobProgress[] = []
	host.on('event', (event) => {
		if (event.type === 'test-job-progress') progress.push(event)
	})
	const result = await run(value)
	expect(result).toMatchObject({
		status: 'completed',
		sent: 23,
		uncertain: 0,
		workers: 4,
		batchSize: 3,
		sendBatches: 8,
	})
	expect(result.workerResults.filter((worker) => worker.sent > 0)).toHaveLength(4)
	expect(result.workerResults.reduce((sum, worker) => sum + worker.sent, 0)).toBe(23)
	expect(result.latency.send.samples).toBe(8)
	expect(result.latency.send.minMs).toBeGreaterThanOrEqual(20)
	expect(result.latency.send.p50Ms!).toBeLessThanOrEqual(result.latency.send.p95Ms!)
	expect(result.latency.send.p95Ms!).toBeLessThanOrEqual(result.latency.send.p99Ms!)
	expect(result.latency.send.p99Ms!).toBeLessThanOrEqual(result.latency.send.maxMs!)
	expect(result.latency.receive).toMatchObject({ samples: 0, meanMs: null, p95Ms: null })
	expect(new Set((await peek(destination)).items.map((message) => message.messageId))).toEqual(
		new Set(Array.from({ length: 23 }, (_, index) => `${value.id}-${index + 1}`)),
	)
	expect(progress.every((event, index) => !index || event.sent >= progress[index - 1].sent)).toBe(
		true,
	)
	expect(progress.at(-1)).toMatchObject({ activeWorkers: 0, sent: 23 })
	expect(await run(value)).toEqual(result)
})

it('reserves receive slots across workers without completing past the shared count', async () => {
	await start()
	await run({ ...input(), workers: 3, batchSize: 4, maxMessages: 23 })
	const result = await run({ ...input('receive'), workers: 4, batchSize: 3, maxMessages: 17 })
	expect(result).toMatchObject({ status: 'completed', received: 17, completed: 17, uncertain: 0 })
	expect(result.workerResults.reduce((sum, worker) => sum + worker.completed, 0)).toBe(17)
	expect(result.latency.complete.samples).toBe(17)
	expect(result.latency.receive.samples).toBeGreaterThanOrEqual(6)
	expect((await peek()).items).toHaveLength(6)
})

it('retains every in-flight batch as uncertain and never retries it', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'test-concurrent-unknown' }
	const result = await run({
		...input('send', destination),
		workers: 3,
		batchSize: 4,
		maxMessages: 20,
	})
	expect(result).toMatchObject({ status: 'unknown', sent: 0, uncertain: 12, sendBatches: 0 })
	expect(result.workerResults.map((worker) => worker.uncertain)).toEqual([4, 4, 4])
	const ids = result.workerResults.flatMap((worker) => worker.uncertainMessageIds)
	expect(new Set(ids).size).toBe(12)
	expect(new Set((await peek(destination)).items.map((message) => message.messageId))).toEqual(
		new Set(ids),
	)
	expect(result.latency.send.samples).toBe(0)
	expect(JSON.stringify(result)).not.toContain('SECRET')
})

it('cancels concurrent paced batches and keeps only acknowledged latency samples', async () => {
	await start()
	const destination: PeekTarget = { kind: 'queue', name: 'test-concurrent' }
	const controller = new AbortController()
	const value = {
		...input('send', destination),
		workers: 4,
		batchSize: 3,
		maxMessages: 100,
		delayMs: 500,
	}
	host.on('event', (event) => {
		if (event.type === 'test-job-progress' && event.sent > 0) controller.abort()
	})
	const result = await run(value, controller.signal)
	expect(['cancelled', 'unknown']).toContain(result.status)
	expect(result.sent).toBeGreaterThan(0)
	expect(result.sent).toBeLessThan(100)
	expect(
		result.workerResults.reduce((sum, worker) => sum + worker.uncertainMessageIds.length, 0),
	).toBe(result.uncertain)
	expect(result.latency.send.samples).toBe(result.sendBatches)
	const actual = (await peek(destination)).items.length
	expect(actual).toBeGreaterThanOrEqual(result.sent)
	expect(actual).toBeLessThanOrEqual(result.sent + result.uncertain)
})

it('keeps empty receive timing absent and limits selected sessions to one receive owner', async () => {
	await start()
	const result = await run({ ...input('receive'), workers: 3, batchSize: 5, maxSeconds: 1 })
	expect(result).toMatchObject({ status: 'limited', completed: 0, uncertain: 0 })
	expect(result.receiveCalls).toBeGreaterThan(0)
	expect(result.latency.receive).toMatchObject({ samples: 0, p50Ms: null, meanMs: null })
	const bad = {
		...input('receive', { kind: 'queue', name: 'sessions' }),
		workers: 2,
		sessionId: 'one',
	}
	expect(testJobRequestSchema.safeParse(bad).success).toBe(false)
	await expect(run(bad)).rejects.toThrow('one receive worker')
})

const expectedBytes = (seed: number, index: number, size: number) =>
	Buffer.concat(
		Array.from({ length: Math.ceil(size / 32) }, (_, block) =>
			createHash('sha256').update(`${seed}:${index}:${block}`, 'ascii').digest(),
		),
	).subarray(0, size)
async function bodyBytes(snapshotId: string) {
	return Buffer.from(
		(await host.request('sb.body', { ...request(), snapshotId, offset: 0, count: 65536 }))
			.base64,
		'base64',
	)
}
it('previews exact seeded bytes independently of worker order and sends them unchanged', async () => {
	await start()
	const value = {
		...input(),
		generator: { kind: 'binary' as const, seed: 42, sizeBytes: 1025 },
		body: '',
		contentType: '',
		maxMessages: 7,
		workers: 3,
		batchSize: 2,
	}
	const sample = await host.request('test.payload.preview', {
		id: value.id,
		generator: value.generator,
		body: '',
		contentType: '',
		sampleIndex: 5,
	})
	expect(sample).toMatchObject({ byteLength: 1025, contentType: 'application/octet-stream' })
	expect(Buffer.from(sample.contentBase64, 'base64')).toEqual(expectedBytes(42, 5, 1025))
	const result = await run(value)
	expect(result).toMatchObject({ status: 'completed', sent: 7, generator: value.generator })
	for (const message of (await peek()).items) {
		const index = Number(message.messageId!.split('-').at(-1))
		expect(await bodyBytes(message.snapshotId!)).toEqual(expectedBytes(42, index, 1025))
	}
})
it('renders indexed JSON, nested objects, Unicode and exact numeric tokens without executing code', async () => {
	await start()
	const value = {
		...input(),
		generator: { kind: 'json-template' as const, seed: 7, sizeBytes: 1024 },
		body: '{"index":{{ index }},"id":"{{messageId}}","n":9007199254740993,"city":"Málaga 🚀","nested":{"random":{{random}}}}',
		contentType: '',
		workers: 3,
		batchSize: 2,
		maxMessages: 5,
	}
	const preview = await host.request('test.payload.preview', {
		id: value.id,
		generator: value.generator,
		body: value.body,
		contentType: '',
		sampleIndex: 1,
	})
	expect(Buffer.from(preview.contentBase64, 'base64').toString()).toContain('9007199254740993')
	expect(await run(value)).toMatchObject({ status: 'completed', sent: 5 })
	for (const message of (await peek()).items) {
		const text = (await bodyBytes(message.snapshotId!)).toString(),
			index = Number(message.messageId!.split('-').at(-1))
		expect(text).toContain('9007199254740993')
		expect(JSON.parse(text)).toMatchObject({
			index,
			id: message.messageId,
			city: 'Málaga 🚀',
			nested: { random: expectedBytes(7, index, 4).readUInt32BE() },
		})
		if (index === 1) expect(Buffer.from(preview.contentBase64, 'base64').toString()).toBe(text)
	}
})
it('rejects invalid, unknown and oversized generated payloads before any send', async () => {
	await start()
	for (const change of [
		{ generator: { kind: 'script', seed: 1, sizeBytes: 10 }, body: 'process.exit()' },
		{ generator: { kind: 'binary', seed: -1, sizeBytes: 10 }, body: '' },
		{ generator: { kind: 'binary', seed: 1, sizeBytes: 65537 }, body: '' },
		{ generator: { kind: 'binary', seed: 1, sizeBytes: 1, source: 'file' }, body: '' },
		{ generator: { kind: 'json-template', seed: 1, sizeBytes: 1 }, body: '{"x":{{unknown}}}' },
		{ generator: { kind: 'json-template', seed: 1, sizeBytes: 1 }, body: '{"x":}' },
		{
			generator: { kind: 'json-template', seed: 1, sizeBytes: 1 },
			body: '"' + '€'.repeat(22000) + '"',
		},
	])
		await expect(
			run({ ...input(), contentType: '', ...change } as TestJobRequest),
		).rejects.toThrow()
	expect((await peek()).items).toHaveLength(0)
})
it('abandons each sequence at most once and stops before cycling redeliveries', async () => {
	await start()
	await seed('one')
	const result = await run({ ...input('receive'), settlement: 'abandon', maxMessages: 10 })
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'redelivery',
		settled: 1,
		abandoned: 1,
		completed: 0,
		redelivered: 1,
		uncertain: 0,
	})
	expect(result.latency.settle.samples).toBe(1)
	expect(result.latency.complete.samples).toBe(0)
	expect((await peek()).items.map((message) => message.messageId)).toEqual(['one'])
})
it('defers exact sequences, records scoped references and retrieves them normally', async () => {
	await start()
	await run({ ...input(), maxMessages: 5 })
	const value = {
		...input('receive'),
		settlement: 'defer' as const,
		maxMessages: 3,
		workers: 2,
		batchSize: 2,
	}
	const result = await run(value)
	expect(result).toMatchObject({
		status: 'completed',
		settled: 3,
		deferred: 3,
		completed: 0,
		referenceWarning: null,
	})
	expect(result.deferredSequenceNumbers).toHaveLength(3)
	expect(
		result.deferredSequenceNumbers.every((sequence) => BigInt(sequence) > 9007199254740991n),
	).toBe(true)
	const refs = await host.request('sb.defer.list', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
	})
	expect(new Set(refs.items.map((entry) => entry.sequenceNumber))).toEqual(
		new Set(result.deferredSequenceNumbers),
	)
	const delivery = await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
		deferredSequence: result.deferredSequenceNumbers[0],
	})
	expect(delivery.items).toHaveLength(1)
	await host.request('sb.close-receiver', request())
})
it('dead-letters only the shared count and preserves the selected reason', async () => {
	await start()
	await run({ ...input(), maxMessages: 7 })
	const result = await run({
		...input('receive'),
		settlement: 'dead-letter',
		deadLetterReason: 'BetaReview',
		deadLetterDescription: 'Synthetic data',
		maxMessages: 5,
		workers: 3,
		batchSize: 2,
	})
	expect(result).toMatchObject({
		status: 'completed',
		settled: 5,
		deadLettered: 5,
		completed: 0,
		uncertain: 0,
	})
	expect((await peek()).items).toHaveLength(2)
	const dead = await peek(target, 'dead-letter')
	expect(dead.items).toHaveLength(5)
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: dead.items[0].snapshotId!,
	})
	expect(details.applicationProperties).toContainEqual(
		expect.objectContaining({ name: 'DeadLetterReason', value: 'BetaReview' }),
	)
	expect(result.workerResults.reduce((sum, worker) => sum + worker.settled, 0)).toBe(5)
})
it('bounds deferrals and validates settlement settings at both boundaries', async () => {
	await start()
	for (const change of [
		{ settlement: 'defer', maxMessages: 1001 },
		{ settlement: 'dead-letter' },
		{ settlement: 'unknown' },
		{ deadLetterReason: 'unused' },
		{ generator: { kind: 'binary', seed: 1, sizeBytes: 1 } },
	]) {
		const bad = { ...input('receive'), ...change }
		expect(testJobRequestSchema.safeParse(bad).success).toBe(false)
		await expect(run(bad as TestJobRequest)).rejects.toThrow()
	}
})
for (const settlement of ['abandon', 'defer', 'dead-letter'] as const)
	it(`retains an uncertain ${settlement} sequence without retry`, async () => {
		await start()
		await seed('unknown-complete')
		const value = {
			...input('receive'),
			settlement,
			...(settlement === 'dead-letter' ? { deadLetterReason: 'Review' } : {}),
		}
		const result = await run(value)
		expect(result).toMatchObject({ status: 'unknown', settled: 0, uncertain: 1 })
		expect(result.workerResults[0].uncertainSequenceNumber).toMatch(/^\d+$/)
		expect(result.latency.settle.samples).toBe(0)
		expect(await run(value)).toEqual(result)
	})
