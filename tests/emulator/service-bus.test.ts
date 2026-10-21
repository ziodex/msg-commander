import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import { defaultEntitySettings, entityPath } from '../../src/shared/entity-management'
import type { Delivery, MessageDraft } from '../../src/shared/message-operations'
import type { EntityTarget, PeekTarget, MessageSubQueue } from '../../src/shared/service-bus'
import type { TestJobRequest } from '../../src/shared/contracts/service-bus/test-jobs'

let host: Backend, connectionId: string, queue: PeekTarget
const created: EntityTarget[] = []
const request = () => ({ id: randomUUID(), connectionId })
const testInput = (changes: Partial<TestJobRequest> = {}): TestJobRequest => ({
	...request(),
	target: queue,
	mode: 'send',
	maxMessages: 37,
	maxSeconds: 40,
	workers: 3,
	batchSize: 5,
	generator: { kind: 'literal', seed: 1, sizeBytes: 1024 },
	settlement: 'complete',
	deadLetterReason: '',
	deadLetterDescription: '',
	delayMs: 0,
	sessionId: '',
	body: '{"tool":"test","city":"Málaga 🚀"}',
	contentType: 'application/json',
	acknowledged: true,
	...changes,
})
const configuration = (target: EntityTarget) =>
	host.request('sb.entity-config', { ...request(), target })
async function create(target: EntityTarget, session = false) {
	const settings = { ...defaultEntitySettings(target.kind), defaultMessageTimeToLive: '01:00:00' }
	if (target.kind !== 'topic') settings.requiresSession = session
	expect(
		await host.request('sb.entity.create', { ...request(), target, settings }),
	).toMatchObject({
		status: 'confirmed',
	})
	created.push(target)
}
beforeEach(async () => {
	expect((await fetch('http://127.0.0.1:5300/health')).ok).toBe(true)
	created.length = 0
	host = new Backend('dotnet', [
		resolve('backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll'),
	])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Docker integration',
				service: 'service-bus',
				namespace: 'localhost',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				rememberSecret: false,
				emulatorManagementPort: 5300,
				secret: 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;',
			},
		})
	).connectionId
	queue = { kind: 'queue', name: `commander-${randomUUID()}` }
	await create(queue)
})
afterEach(async () => {
	try {
		if (connectionId) {
			await host.request('sb.close-receiver', request())
			for (const target of created.reverse()) {
				const current = await configuration(target)
				expect(
					await host.request('sb.entity.delete', {
						...request(),
						target,
						expectedRevision: current.revision,
						confirmation: entityPath(target),
					}),
				).toMatchObject({ status: 'confirmed' })
			}
		}
	} finally {
		await host?.stop()
		connectionId = ''
	}
})
const draft = (bytes: Buffer, contentType = 'application/octet-stream'): MessageDraft => ({
	...emptyDraft(bytes.toString('base64'), contentType),
	properties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
})
async function send(value: MessageDraft, target = queue) {
	expect(
		await host.request('sb.send', {
			...request(),
			target: target as { kind: 'queue'; name: string },
			draft: value,
		}),
	).toMatchObject({ status: 'confirmed' })
}
const peek = (target = queue, subQueue: MessageSubQueue = 'active') =>
	host.request('sb.peek', {
		...request(),
		target,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
const receive = (
	options: {
		target?: PeekTarget
		sessionId?: string
		deferredSequence?: string
		subQueue?: MessageSubQueue
	} = {},
) =>
	host.request('sb.receive', {
		...request(),
		target: queue,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 10,
		waitSeconds: 2,
		...options,
	})
async function settle(
	item: Delivery,
	action: 'complete' | 'abandon' | 'dead-letter' | 'defer' | 'renew',
) {
	expect(
		await host.request('sb.settle', {
			...request(),
			deliveryId: item.deliveryId,
			action,
			reason: 'Synthetic test',
			description: 'Docker integration',
		}),
	).toMatchObject({ status: 'confirmed' })
}

it('runs concurrent batched test jobs with exact shared counts and latency statistics', async () => {
	const input = testInput()
	const sent = await host.request('sb.test.run', input, { timeout: 50000 })
	expect(sent).toMatchObject({
		status: 'completed',
		sent: 37,
		uncertain: 0,
		workers: 3,
		batchSize: 5,
		sendBatches: 8,
	})
	expect(sent.workerResults.filter((worker) => worker.sent > 0)).toHaveLength(3)
	expect(sent.workerResults.reduce((sum, worker) => sum + worker.sent, 0)).toBe(37)
	expect(sent.latency.send.samples).toBe(sent.sendBatches)
	expect(sent.latency.send.p50Ms!).toBeLessThanOrEqual(sent.latency.send.p95Ms!)
	expect(sent.latency.send.p95Ms!).toBeLessThanOrEqual(sent.latency.send.p99Ms!)
	expect(sent.latency.send.maxMs).toBeGreaterThan(0)
	expect(await host.request('sb.test.run', input)).toEqual(sent)
	const page = await peek()
	const first = await host.request('sb.inspect', {
		...request(),
		snapshotId: page.items[0].snapshotId!,
	})
	expect(first.applicationProperties).toContainEqual({
		name: 'commander-test-job',
		type: 'string',
		value: input.id,
	})
	const result = await host.request(
		'sb.test.run',
		testInput({
			mode: 'receive',
			body: '',
			contentType: '',
			maxMessages: 29,
			workers: 3,
			batchSize: 4,
		}),
		{ timeout: 50000 },
	)
	expect(result).toMatchObject({ status: 'completed', received: 29, completed: 29, uncertain: 0 })
	expect(result.workerResults.reduce((sum, worker) => sum + worker.completed, 0)).toBe(29)
	expect(result.latency.complete.samples).toBe(29)
	expect(result.latency.receive.samples).toBeGreaterThan(0)
	expect((await peek()).items).toHaveLength(8)
})

it('splits large test batches at the broker limit and preserves every message', async () => {
	const value = testInput({ maxMessages: 13, workers: 2, batchSize: 10, body: 'x'.repeat(65536) })
	const result = await host.request('sb.test.run', value, { timeout: 50000 })
	expect(result).toMatchObject({ status: 'completed', sent: 13, uncertain: 0 })
	expect(result.sendBatches).toBeGreaterThan(2)
	expect(result.latency.send.samples).toBe(result.sendBatches)
	const messages = (await peek()).items
	expect(new Set(messages.map((message) => message.messageId))).toEqual(
		new Set(Array.from({ length: 13 }, (_, index) => `${value.id}-${index + 1}`)),
	)
	expect(messages.every((message) => message.bodySize === 65536)).toBe(true)
})

it('batches a selected-session test with one receive owner and leaves the remainder intact', async () => {
	const sessions: PeekTarget = { kind: 'queue', name: `tools-session-${randomUUID()}` }
	await create(sessions, true)
	expect(
		await host.request(
			'sb.test.run',
			testInput({
				target: sessions,
				sessionId: 'tools-one',
				maxMessages: 12,
				workers: 2,
				batchSize: 5,
			}),
		),
	).toMatchObject({ status: 'completed', sent: 12 })
	const result = await host.request(
		'sb.test.run',
		testInput({
			target: sessions,
			sessionId: 'tools-one',
			mode: 'receive',
			body: '',
			contentType: '',
			maxMessages: 9,
			workers: 1,
			batchSize: 4,
		}),
		{ timeout: 50000 },
	)
	expect(result).toMatchObject({ status: 'completed', received: 9, completed: 9, uncertain: 0 })
	expect(result.latency.complete.samples).toBe(9)
	expect((await peek(sessions)).items).toHaveLength(3)
})

it('cancels paced workers, retains a partial receipt and resumes with a separate job', async () => {
	const controller = new AbortController()
	const value = testInput({ maxMessages: 1000, delayMs: 500, batchSize: 3 })
	host.on('event', (event) => {
		if (event.type === 'test-job-progress' && event.operationId === value.id && event.sent >= 3)
			controller.abort()
	})
	const result = await host.request('sb.test.run', value, {
		signal: controller.signal,
		waitForCancellation: true,
		timeout: 50000,
	})
	expect(['cancelled', 'unknown']).toContain(result.status)
	expect(result.sent).toBeGreaterThan(0)
	expect(result.sent).toBeLessThan(1000)
	expect(result.latency.send.samples).toBe(result.sendBatches)
	expect(await host.request('sb.test.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	const actual = (await peek()).items.length
	expect(actual).toBeGreaterThanOrEqual(result.sent)
	expect(actual).toBeLessThanOrEqual(result.sent + result.uncertain)
	const next = await host.request(
		'sb.test.run',
		testInput({ maxMessages: 1, workers: 1, batchSize: 1 }),
	)
	expect(next).toMatchObject({ status: 'completed', sent: 1, uncertain: 0 })
})

it('previews and sends indexed JSON and exact seeded bytes through concurrent workers', async () => {
	const json = testInput({
		maxMessages: 9,
		workers: 3,
		batchSize: 2,
		generator: { kind: 'json-template', seed: 42, sizeBytes: 1024 },
		body: '{"index":{{index}},"id":"{{messageId}}","value":{{random}},"n":9007199254740993}',
		contentType: '',
	})
	const sample = await host.request('test.payload.preview', {
		id: json.id,
		generator: json.generator,
		body: json.body,
		contentType: '',
		sampleIndex: 1,
	})
	expect(await host.request('sb.test.run', json)).toMatchObject({ status: 'completed', sent: 9 })
	for (const message of (await peek()).items) {
		const bytes = Buffer.from(
			(
				await host.request('sb.body', {
					...request(),
					snapshotId: message.snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
			'base64',
		)
		const index = Number(message.messageId!.split('-').at(-1))
		expect(bytes.toString()).toContain('9007199254740993')
		expect(JSON.parse(bytes.toString())).toMatchObject({
			index,
			id: message.messageId,
			value: createHash('sha256').update(`42:${index}:0`, 'ascii').digest().readUInt32BE(),
		})
		if (index === 1) expect(bytes.toString('base64')).toBe(sample.contentBase64)
	}
	expect(
		await host.request(
			'sb.test.run',
			testInput({
				maxMessages: 5,
				generator: { kind: 'binary', seed: 7, sizeBytes: 1025 },
				body: '',
				contentType: '',
			}),
		),
	).toMatchObject({ sent: 5, status: 'completed' })
	const page = await peek()
	for (const message of page.items.filter((m) => m.bodySize === 1025)) {
		const bytes = Buffer.from(
			(
				await host.request('sb.body', {
					...request(),
					snapshotId: message.snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
			'base64',
		)
		const index = Number(message.messageId!.split('-').at(-1))
		const expected = Buffer.concat(
			Array.from({ length: 33 }, (_, block) =>
				createHash('sha256').update(`7:${index}:${block}`, 'ascii').digest(),
			),
		).subarray(0, 1025)
		expect(bytes).toEqual(expected)
	}
	expect(page.items.filter((m) => m.bodySize === 1025)).toHaveLength(5)
})

it('abandons once and stops on redelivery without cycling a message into the DLQ', async () => {
	await host.request('sb.test.run', testInput({ maxMessages: 1, workers: 1, batchSize: 1 }))
	const result = await host.request(
		'sb.test.run',
		testInput({
			mode: 'receive',
			body: '',
			contentType: '',
			settlement: 'abandon',
			maxMessages: 20,
			workers: 1,
			batchSize: 1,
		}),
	)
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'redelivery',
		abandoned: 1,
		settled: 1,
		completed: 0,
		redelivered: 1,
		uncertain: 0,
	})
	expect(result.latency.settle.samples).toBe(1)
	expect((await peek()).items).toHaveLength(1)
	expect((await peek(queue, 'dead-letter')).items).toHaveLength(0)
})

it('records deferred sequences, retrieves them and dead-letters only the requested remainder', async () => {
	await host.request('sb.test.run', testInput({ maxMessages: 11 }))
	const deferred = await host.request(
		'sb.test.run',
		testInput({
			mode: 'receive',
			body: '',
			contentType: '',
			settlement: 'defer',
			maxMessages: 4,
			workers: 2,
			batchSize: 2,
		}),
	)
	expect(deferred).toMatchObject({
		status: 'completed',
		deferred: 4,
		settled: 4,
		completed: 0,
		referenceWarning: null,
	})
	const refs = await host.request('sb.defer.list', {
		...request(),
		target: queue,
		subQueue: 'active',
		sessionId: '',
	})
	expect(new Set(refs.items.map((item) => item.sequenceNumber))).toEqual(
		new Set(deferred.deferredSequenceNumbers),
	)
	const held = (await receive({ deferredSequence: deferred.deferredSequenceNumbers[0] })).items[0]
	expect(held.summary.sequenceNumber).toBe(deferred.deferredSequenceNumbers[0])
	await settle(held, 'complete')
	await host.request('sb.close-receiver', request())
	const dead = await host.request(
		'sb.test.run',
		testInput({
			mode: 'receive',
			body: '',
			contentType: '',
			settlement: 'dead-letter',
			deadLetterReason: 'BetaCheck',
			deadLetterDescription: 'Docker test',
			maxMessages: 5,
			workers: 3,
			batchSize: 2,
		}),
	)
	expect(dead).toMatchObject({
		status: 'completed',
		deadLettered: 5,
		settled: 5,
		completed: 0,
		uncertain: 0,
	})
	expect((await peek()).items).toHaveLength(5) // two active and three deferred; peek includes deferred messages.
	const dlq = await peek(queue, 'dead-letter')
	expect(dlq.items).toHaveLength(5)
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: dlq.items[0].snapshotId!,
	})
	expect(JSON.stringify(details)).toContain('BetaCheck')
	expect(dead.latency.settle.samples).toBe(5)
})

it('creates, browses, edits and deletes entities through the production administration adapter', async () => {
	expect(
		await host.request('auth.test', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Docker authentication',
				service: 'service-bus',
				namespace: 'localhost',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				rememberSecret: false,
				emulatorManagementPort: 5300,
				secret: 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;',
			},
		}),
	).toMatchObject({ summary: expect.stringContaining('Manage permission') })
	expect((await host.request('sb.list', { ...request(), kind: 'queue' })).items).toContainEqual(
		expect.objectContaining({ target: queue }),
	)
	const current = await configuration(queue)
	expect(
		await host.request('sb.entity.update', {
			...request(),
			target: queue,
			expectedRevision: current.revision,
			settings: { ...current.settings, maxDeliveryCount: 7 },
		}),
	).toMatchObject({ status: 'confirmed' })
	expect((await configuration(queue)).settings.maxDeliveryCount).toBe(7)
})

it('preserves JSON, binary bytes and Int64 properties through send, peek, inspect, receive and complete', async () => {
	const drafts = [
		draft(Buffer.from('{"n":9007199254740993,"city":"Málaga 🚀"}'), 'application/json'),
		draft(Buffer.from([0, 255, 128, 65])),
	]
	expect(
		await host.request('sb.send.batch', {
			...request(),
			target: queue as { kind: 'queue'; name: string },
			drafts,
			scheduledEnqueueTime: null,
		}),
	).toMatchObject({ status: 'confirmed' })
	const page = await peek()
	expect(page.items).toHaveLength(2)
	for (const [index, item] of page.items.entries()) {
		const details = await host.request('sb.inspect', {
			...request(),
			snapshotId: item.snapshotId!,
		})
		expect(details.applicationProperties).toContainEqual({
			name: 'exact',
			type: 'int64',
			value: '9223372036854775807',
		})
		expect(
			(
				await host.request('sb.body', {
					...request(),
					snapshotId: item.snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
		).toBe(drafts[index].bodyBase64)
	}
	expect((await peek()).items).toHaveLength(2)
	const ids: string[] = []
	for (let attempt = 0; attempt < 3 && ids.length < 2; attempt++) {
		const received = await receive()
		for (const item of received.items) {
			ids.push(item.summary.messageId!)
			await settle(item, 'complete')
		}
	}
	expect(ids.sort()).toEqual(drafts.map((item) => item.messageId).sort())
	expect((await peek()).items).toHaveLength(0)
})

it('renews, abandons, defers/retrieves and dead-letters messages with confirmed outcomes', async () => {
	await send(draft(Buffer.from('deferred')))
	let item = (await receive()).items[0]
	await settle(item, 'renew')
	await settle(item, 'abandon')
	item = (await receive()).items[0]
	await settle(item, 'defer')
	expect(
		(
			await host.request('sb.defer.list', {
				...request(),
				target: queue,
				subQueue: 'active',
				sessionId: '',
			})
		).items,
	).toContainEqual(expect.objectContaining({ sequenceNumber: item.summary.sequenceNumber }))
	const deferred = (await receive({ deferredSequence: item.summary.sequenceNumber })).items[0]
	await settle(deferred, 'complete')
	expect(
		(
			await host.request('sb.defer.list', {
				...request(),
				target: queue,
				subQueue: 'active',
				sessionId: '',
			})
		).items,
	).toHaveLength(0)
	await send(draft(Buffer.from('dead-letter')))
	await settle((await receive()).items[0], 'dead-letter')
	expect((await peek(queue, 'dead-letter')).items).toHaveLength(1)
	await host.request('sb.close-receiver', request())
	await settle((await receive({ subQueue: 'dead-letter' })).items[0], 'complete')
})

it('schedules messages and cancels by exact returned sequence', async () => {
	const outcome = await host.request('sb.send.batch', {
		...request(),
		target: queue as { kind: 'queue'; name: string },
		drafts: [draft(Buffer.from('future'))],
		scheduledEnqueueTime: new Date(Date.now() + 600000).toISOString(),
	})
	expect(outcome.status).toBe('confirmed')
	expect(outcome.sequenceNumbers).toHaveLength(1)
	expect(
		await host.request('sb.scheduled.cancel', {
			...request(),
			target: queue as { kind: 'queue'; name: string },
			sequenceNumbers: outcome.sequenceNumbers!,
			confirmation: `${queue.kind}/${queue.name}`,
		}),
	).toMatchObject({ status: 'confirmed' })
	expect(
		(
			await host.request('sb.scheduled', {
				...request(),
				target: queue as { kind: 'queue'; name: string },
				fromSequenceNumber: '0',
				maxMessages: 25,
			})
		).items,
	).toHaveLength(0)
})

it('receives and completes a selected session', async () => {
	const sessionQueue = { kind: 'queue', name: `session-${randomUUID()}` } as const
	await create(sessionQueue, true)
	await send({ ...draft(Buffer.from('session')), sessionId: 'desktop-session' }, sessionQueue)
	const received = await receive({ target: sessionQueue, sessionId: 'desktop-session' })
	expect(received.items).toHaveLength(1)
	expect(received.items[0].summary.sessionId).toBe('desktop-session')
	await settle(received.items[0], 'complete')
})

it('publishes to a topic and receives its subscription', async () => {
	const topic = { kind: 'topic', name: `topic-${randomUUID()}` } as const
	const subscription = { kind: 'subscription', topicName: topic.name, name: 'all' } as const
	await create(topic)
	await create(subscription)
	const value = draft(Buffer.from('topic'))
	expect(
		await host.request('sb.send', { ...request(), target: topic, draft: value }),
	).toMatchObject({ status: 'confirmed' })
	const received = await receive({ target: subscription })
	expect(received.items).toHaveLength(1)
	expect(received.items[0].summary.messageId).toBe(value.messageId)
	await settle(received.items[0], 'complete')
})
