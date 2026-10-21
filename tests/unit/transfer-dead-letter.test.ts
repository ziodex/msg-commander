import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { subQueueSchema, type MessageSubQueue, type PeekTarget } from '../../src/shared/service-bus'
import { purgeConfirmation } from '../../src/shared/contracts/service-bus/maintenance/index'
import { resendRequestSchema } from '../../src/shared/contracts/service-bus/maintenance/index'
import type { Delivery } from '../../src/shared/message-operations'

const namespace = 'fixture.servicebus.windows.net'
const queue = { kind: 'queue', name: 'orders' } as const
const subscription = { kind: 'subscription', name: 'audit', topicName: 'order-events' } as const
const transfer = 'transfer-dead-letter' as const
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
async function start() {
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				service: 'service-bus',
				namespace,
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
}
afterEach(async () => {
	await host?.stop()
})
const peek = (
	target: PeekTarget = queue,
	subQueue: MessageSubQueue = transfer,
	fromSequenceNumber = '0',
) =>
	host.request('sb.peek', { ...request(), target, subQueue, fromSequenceNumber, maxMessages: 25 })
const receive = (target: PeekTarget = queue, deferredSequence?: string) =>
	host.request('sb.receive', {
		...request(),
		target,
		subQueue: transfer,
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
		...(deferredSequence ? { deferredSequence } : {}),
	})
const settle = (
	item: Delivery,
	action: 'complete' | 'abandon' | 'dead-letter' | 'defer' | 'renew',
) =>
	host.request('sb.settle', {
		...request(),
		deliveryId: item.deliveryId,
		action,
		reason: 'Review',
		description: 'Fixture',
	})
const resendInput = (mode: 'keep' | 'remove', source: PeekTarget = queue) => ({
	...request(),
	source,
	subQueue: transfer,
	destination: { kind: 'queue', name: 'empty' } as const,
	mode,
	idPolicy: 'new' as const,
	maxMessages: 10,
	maxSeconds: 10,
})

it('rejects unknown selectors, active resend sources, topic transfer subqueues and session filters', async () => {
	await start()
	expect(subQueueSchema.safeParse(transfer).success).toBe(true)
	expect(subQueueSchema.safeParse('transfer').success).toBe(false)
	expect(
		resendRequestSchema.safeParse({ ...resendInput('keep'), subQueue: 'active' }).success,
	).toBe(false)
	await expect(peek(queue, 'transfer' as never)).rejects.toThrow('Invalid subqueue')
	await expect(peek({ kind: 'topic', name: 'order-events' } as never)).rejects.toThrow()
	await expect(
		host.request('sb.receive', {
			...request(),
			target: subscription,
			subQueue: transfer,
			sessionId: 'session-001',
			maxMessages: 1,
			waitSeconds: 1,
		}),
	).rejects.toThrow('without a session filter')
	await expect(
		host.request('sb.deadletters.resend', {
			...resendInput('keep'),
			subQueue: 'active' as never,
		}),
	).rejects.toThrow('dead-letter source')
})

it.each([queue, subscription])(
	'peeks and inspects transfer messages on $kind without mixing normal or dead-letter messages',
	async (target) => {
		await start()
		const page = await peek(target)
		expect(page.items.map((m) => m.messageId)).toEqual(['transfer-001'])
		const message = page.items[0]
		expect(BigInt(message.sequenceNumber)).toBeGreaterThan(9007199254740991n)
		const details = await host.request('sb.inspect', {
			...request(),
			snapshotId: message.snapshotId!,
		})
		expect(details.systemProperties).toContainEqual({
			name: 'DeadLetterReason',
			type: 'string',
			value: 'MaxTransferHopCountExceeded',
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
					snapshotId: message.snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
		).toBe('AP9B')
		expect((await peek(target, transfer, page.nextSequenceNumber!)).items).toHaveLength(0)
		expect((await peek(target, 'active')).items.map((m) => m.messageId)).toEqual([
			'received-001',
			'received-002',
		])
		expect((await peek(target, 'dead-letter')).items.map((m) => m.messageId)).toEqual([
			'dead-receive-001',
		])
		const counts = await host.request('sb.runtime', {
			...request(),
			kind: target.kind,
			...(target.kind === 'subscription' ? { topicName: target.topicName } : {}),
		})
		expect(counts.items.find((i) => i.target.name === target.name)?.counts).toMatchObject({
			active: '2',
			deadLetter: '1',
			transferDeadLetter: '1',
			total: '4',
		})
	},
)

it('completes only the owned transfer delivery and refuses dead-lettering it again', async () => {
	await start()
	const batch = await receive()
	expect(batch.subQueue).toBe(transfer)
	expect(batch.sessionId).toBeNull()
	const item = batch.items[0]
	expect(item.summary.messageId).toBe('transfer-001')
	expect((await settle(item, 'dead-letter')).status).toBe('rejected')
	expect((await settle(item, 'complete')).status).toBe('confirmed')
	expect((await peek()).items).toHaveLength(0)
	expect((await peek(queue, 'active')).items).toHaveLength(2)
	expect((await peek(queue, 'dead-letter')).items).toHaveLength(1)
})

it('uses a regular receiver for a session-enabled subscription and scopes deferred retrieval to its subqueue', async () => {
	await start()
	let batch = await receive(subscription)
	expect(batch.session).toBeNull()
	expect(batch.items[0].summary.sessionId).toBe('session-001')
	expect((await settle(batch.items[0], 'renew')).status).toBe('confirmed')
	expect((await settle(batch.items[0], 'abandon')).status).toBe('confirmed')
	batch = await receive(subscription)
	const sequence = batch.items[0].summary.sequenceNumber
	expect((await settle(batch.items[0], 'defer')).status).toBe('confirmed')
	const references = (subQueue: MessageSubQueue = transfer) =>
		host.request('sb.defer.list', {
			...request(),
			target: subscription,
			subQueue,
			sessionId: '',
		})
	expect((await references()).items.map((item) => item.sequenceNumber)).toEqual([sequence])
	expect((await references('dead-letter')).total).toBe(0)
	expect((await references('active')).total).toBe(0)
	expect((await receive(subscription)).items).toHaveLength(0)
	expect((await peek(subscription)).items[0].state).toBe('Deferred')
	batch = await receive(subscription, sequence)
	expect(batch.items[0].summary.sequenceNumber).toBe(sequence)
	expect((await references()).total).toBe(0)
	expect((await settle(batch.items[0], 'complete')).status).toBe('confirmed')
	expect((await peek(subscription, 'dead-letter')).items).toHaveLength(1)
})

it('transactionally replays a received transfer message after a rejected destination without completing its siblings', async () => {
	await start()
	const item = (await receive()).items[0]
	const replay = (name: string) =>
		host.request('sb.replay', {
			...request(),
			deliveryId: item.deliveryId,
			destination: { kind: 'queue', name },
			idPolicy: 'new',
			messageId: randomUUID(),
		})
	expect((await replay('reject-replay')).status).toBe('rejected')
	expect((await peek()).items).toHaveLength(1)
	expect((await replay('empty')).status).toBe('confirmed')
	expect((await peek()).items).toHaveLength(0)
	expect((await peek({ kind: 'queue', name: 'empty' }, 'active')).items).toHaveLength(1)
	expect((await peek(queue, 'dead-letter')).items).toHaveLength(1)
})

it.each(['keep', 'remove'] as const)(
	'bulk resends only transfer messages in %s mode and binds receipts to the subqueue',
	async (mode) => {
		await start()
		const value = resendInput(mode, subscription)
		const result = await host.request('sb.deadletters.resend', value)
		expect(result).toMatchObject({
			subQueue: transfer,
			sent: 1,
			removed: mode === 'remove' ? 1 : 0,
			uncertain: 0,
		})
		expect((await host.request('sb.deadletters.resend', value)).sent).toBe(1)
		await expect(
			host.request('sb.deadletters.resend', { ...value, subQueue: 'dead-letter' }),
		).rejects.toThrow('different request')
		expect((await peek(subscription)).items).toHaveLength(mode === 'remove' ? 0 : 1)
		expect((await peek(subscription, 'dead-letter')).items).toHaveLength(1)
		expect((await peek(subscription, 'active')).items).toHaveLength(2)
		const destination = await peek(value.destination, 'active')
		expect(destination.items).toHaveLength(1)
		expect(
			(
				await host.request('sb.body', {
					...request(),
					snapshotId: destination.items[0].snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
		).toBe('AP9B')
	},
)

it('requires the transfer subqueue in purge confirmation and keeps ordinary DLQ/main messages', async () => {
	await start()
	const value = {
		...request(),
		target: subscription,
		subQueue: transfer,
		confirmation: purgeConfirmation(namespace, subscription, transfer),
		maxMessages: 1,
		maxSeconds: 10,
	}
	await expect(
		host.request('sb.purge', {
			...value,
			confirmation: purgeConfirmation(namespace, subscription, 'dead-letter'),
		}),
	).rejects.toThrow('exact namespace')
	expect(await host.request('sb.purge', value)).toMatchObject({
		subQueue: transfer,
		completed: 1,
		uncertain: 0,
		status: 'limited',
	})
	expect((await peek(subscription)).items).toHaveLength(0)
	expect((await peek(subscription, 'dead-letter')).items).toHaveLength(1)
	expect((await peek(subscription, 'active')).items).toHaveLength(2)
})

it('records an uncertain transfer completion without a retry or touching ordinary dead letters', async () => {
	await start()
	const target = { kind: 'queue', name: 'transfer-unknown' } as const
	const value = {
		...request(),
		target,
		subQueue: transfer,
		confirmation: purgeConfirmation(namespace, target, transfer),
		maxMessages: 10,
		maxSeconds: 10,
	}
	expect(await host.request('sb.purge', value)).toMatchObject({
		status: 'unknown',
		completed: 0,
		uncertain: 1,
	})
	expect(await host.request('sb.purge', value)).toMatchObject({ completed: 0, uncertain: 1 })
	expect((await peek(target)).items).toHaveLength(0)
	expect((await peek(target, 'dead-letter')).items).toHaveLength(1)
})
