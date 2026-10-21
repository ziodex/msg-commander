import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import type { BackendMethods } from '../../src/shared/contracts'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	resendRequestSchema,
	type ResendRequest,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import type { PeekTarget } from '../../src/shared/service-bus'
import type { SendTarget } from '../../src/shared/message-operations'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const namespace = 'fixture.servicebus.windows.net'
const source = { kind: 'queue', name: 'empty' } as const satisfies PeekTarget
let host: Backend, connectionId: string
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
function input(
	mode: 'keep' | 'remove' = 'keep',
	target: PeekTarget = source,
	destination: SendTarget = source,
): ResendRequest {
	return {
		...request(),
		source: target,
		destination,
		mode,
		idPolicy: 'new',
		maxMessages: 100,
		maxSeconds: 10,
	}
}
const resend = (
	value: BackendMethods['sb.deadletters.resend']['params'] = cross(),
	signal?: AbortSignal,
) =>
	host.request('sb.deadletters.resend', value, {
		signal,
		timeout: 20000,
		waitForCancellation: true,
	})
const peek = (target: PeekTarget = source, subQueue: 'active' | 'dead-letter' = 'dead-letter') =>
	host.request('sb.peek', {
		...request(),
		target,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
async function seed(ids = ['first', 'second'], target: PeekTarget = source, sessionId = '') {
	for (const messageId of ids)
		await host.request('sb.send', {
			...request(),
			target: target.kind === 'queue' ? target : { kind: 'topic', name: target.topicName },
			draft: {
				...emptyDraft('AP9B'),
				messageId,
				sessionId,
				ttlSeconds: 3600,
				subject: 'Exact source',
				properties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
			},
		})
	const batch = await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId,
		maxMessages: ids.length,
		waitSeconds: 1,
	})
	for (const item of batch.items)
		await host.request('sb.settle', {
			...request(),
			deliveryId: item.deliveryId,
			action: 'dead-letter',
			reason: 'Failed',
			description: 'Original failure',
		})
	await host.request('sb.close-receiver', request())
}
afterEach(async () => {
	await host?.stop()
})
const destinationProfile = {
	id: randomUUID(),
	name: 'Recovery',
	service: 'service-bus' as const,
	namespace: 'recovery.fixture.servicebus.windows.net',
	auth: 'sas' as const,
	tenantId: '',
	clientId: '',
	secret: 'SECRET fixture destination',
	rememberSecret: false,
}
function cross(
	mode: 'keep' | 'remove' = 'keep',
	target: PeekTarget = source,
	destination: SendTarget = source,
) {
	return {
		...input(mode, target, destination),
		destinationProfileId: destinationProfile.id,
		destinationNamespace: destinationProfile.namespace,
		acknowledgeNonAtomic: mode === 'remove',
		destinationProfile,
	}
}
async function openDestination(profile = destinationProfile) {
	connectionId = (await host.request('sb.connect', { operationId: randomUUID(), profile }))
		.connectionId
}
it('validates paired destination fields and separate-write acknowledgement in both IPC and host', async () => {
	await start()
	await seed(['one'])
	const value = cross('remove')
	const { destinationProfile: _, ...publicRequest } = value
	expect(resendRequestSchema.safeParse(publicRequest).success).toBe(true)
	expect(resendRequestSchema.safeParse(value).success).toBe(false) // The renderer cannot inject credentials.
	for (const bad of [
		{ ...value, acknowledgeNonAtomic: false },
		{ ...value, destinationProfile: undefined },
		{ ...value, destinationNamespace: 'changed.servicebus.windows.net' },
		{ ...value, destinationProfileId: randomUUID() },
		{ ...value, destinationProfile: { ...destinationProfile, service: 'event-hubs' as never } },
		{
			...value,
			destinationNamespace: namespace,
			destinationProfile: { ...destinationProfile, namespace },
		},
	])
		await expect(resend(bad)).rejects.toThrow()
	expect(
		resendRequestSchema.safeParse({ ...publicRequest, acknowledgeNonAtomic: false }).success,
	).toBe(false)
	expect(
		resendRequestSchema.safeParse({ ...publicRequest, destinationNamespace: undefined })
			.success,
	).toBe(false)
	expect((await peek()).items).toHaveLength(1)
})
it.each(['keep', 'remove'] as const)(
	'recovers exact bytes and properties in %s mode and records both namespace identities',
	async (mode) => {
		await start()
		await seed(['first', 'second'])
		const value = cross(mode)
		const result = await resend(value)
		expect(result).toMatchObject({
			status: 'completed',
			sent: 2,
			removed: mode === 'remove' ? 2 : 0,
			uncertain: 0,
			copiedNotRemoved: 0,
			crossNamespace: true,
			sourceNamespace: namespace,
			destinationNamespace: destinationProfile.namespace,
		})
		expect(result.transfers).toHaveLength(2)
		expect(
			result.transfers.every(
				(r) =>
					r.send === 'confirmed' && r.source === (mode === 'keep' ? 'kept' : 'removed'),
			),
		).toBe(true)
		expect((await peek()).items).toHaveLength(mode === 'keep' ? 2 : 0)
		expect((await peek(source, 'active')).items).toHaveLength(0)
		expect(await resend(value)).toEqual(result)
		expect(
			await resend({
				...value,
				destinationProfile: { ...destinationProfile, secret: 'rotated fixture' },
			}),
		).toEqual(result)
		await expect(
			resend({ ...value, destination: { kind: 'queue', name: 'different' } }),
		).rejects.toThrow('different request')
		expect(JSON.stringify(result)).not.toContain('SECRET')
		await openDestination()
		const page = await peek(source, 'active')
		expect(page.items.map((m) => m.messageId)).toEqual(
			result.transfers.map((t) => t.outgoingMessageId),
		)
		const snapshotId = page.items[0].snapshotId!
		const details = await host.request('sb.inspect', { ...request(), snapshotId })
		expect(details.applicationProperties).toEqual([
			{ name: 'exact', type: 'int64', value: '9223372036854775807' },
		])
		expect(
			(await host.request('sb.body', { ...request(), snapshotId, offset: 0, count: 65536 }))
				.base64,
		).toBe('AP9B')
	},
)
it('does not remove an original when destination send is rejected', async () => {
	await start()
	await seed(['one'])
	const result = await resend(
		cross('remove', source, { kind: 'queue', name: 'resend-reject-send' }),
	)
	expect(result).toMatchObject({
		status: 'failed',
		sent: 0,
		removed: 0,
		uncertain: 0,
		copiedNotRemoved: 0,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'not-sent', source: 'not-removed' })
	expect((await peek()).items).toHaveLength(1)
})
it('stops an ambiguous destination send without attempting source completion or retrying', async () => {
	await start()
	await seed(['one', 'two'])
	const value = cross('remove', source, { kind: 'queue', name: 'resend-unknown-send' })
	const result = await resend(value)
	expect(result).toMatchObject({
		status: 'unknown',
		examined: 1,
		sent: 0,
		removed: 0,
		uncertain: 1,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'unknown', source: 'not-removed' })
	expect((await peek()).items).toHaveLength(2)
	expect(await resend(value)).toEqual(result)
	await openDestination()
	expect(
		(await peek({ kind: 'queue', name: value.destination.name }, 'active')).items.map(
			(m) => m.messageId,
		),
	).toEqual([result.outgoingMessageId])
})
it('retains a confirmed copy when completion is rejected and stops before the next send', async () => {
	await start()
	await seed(['purge-reject-complete', 'second'])
	const result = await resend(cross('remove'))
	expect(result).toMatchObject({
		status: 'failed',
		examined: 1,
		sent: 1,
		removed: 0,
		uncertain: 0,
		copiedNotRemoved: 1,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'confirmed', source: 'not-removed' })
	expect((await peek()).items).toHaveLength(2)
	await openDestination()
	expect((await peek(source, 'active')).items.map((m) => m.messageId)).toEqual([
		result.outgoingMessageId,
	])
})
it('distinguishes unknown source completion from an uncertain destination send', async () => {
	await start()
	await seed(['recovery-complete-unknown', 'second'])
	const result = await resend(cross('remove'))
	expect(result).toMatchObject({
		status: 'unknown',
		sent: 1,
		removed: 0,
		uncertain: 1,
		copiedNotRemoved: 1,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'confirmed', source: 'unknown' })
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['second'])
	await openDestination()
	expect((await peek(source, 'active')).items).toHaveLength(1)
})
it('cancellation between acknowledged send and source completion retains both copies and a readable receipt', async () => {
	await start()
	await seed(['one'])
	const value = cross('remove', source, { kind: 'queue', name: 'resend-commit-late' })
	const controller = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'resend-progress' && e.phase === 'sending')
			setTimeout(() => controller.abort(), 40)
	})
	const result = await resend(value, controller.signal)
	expect(result).toMatchObject({
		status: 'cancelled',
		sent: 1,
		removed: 0,
		uncertain: 0,
		copiedNotRemoved: 1,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'confirmed', source: 'not-removed' })
	expect((await peek()).items).toHaveLength(1)
	expect(
		await host.request('sb.deadletters.result', { ...request(), operationId: value.id }),
	).toEqual(result)
})
it('cancelled source completion retains destination confirmation and marks only removal uncertain', async () => {
	await start()
	await seed(['purge-wait-complete'])
	const value = cross('remove'),
		controller = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'resend-progress' && e.phase === 'completing')
			setTimeout(() => controller.abort(), 50)
	})
	const result = await resend(value, controller.signal)
	expect(result).toMatchObject({
		status: 'unknown',
		sent: 1,
		removed: 0,
		uncertain: 1,
		copiedNotRemoved: 1,
	})
	expect(result.transfers[0]).toMatchObject({ send: 'confirmed', source: 'unknown' })
})
it('counts late acknowledged source completion after cancellation as removed', async () => {
	await start()
	await seed(['purge-commit-late'])
	const value = { ...cross('remove'), maxMessages: 1 },
		controller = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'resend-progress' && e.phase === 'completing')
			setTimeout(() => controller.abort(), 40)
	})
	const result = await resend(value, controller.signal)
	expect(result).toMatchObject({
		status: 'limited',
		sent: 1,
		removed: 1,
		uncertain: 0,
		copiedNotRemoved: 0,
	})
	expect((await peek()).items).toHaveLength(0)
})
it('includes authentication in the time limit, reports device-code progress, and preserves the source connection', async () => {
	await start()
	await seed(['one'])
	const slowProfile = {
		...destinationProfile,
		namespace: 'recovery-slow.fixture.servicebus.windows.net',
	}
	const events: unknown[] = []
	host.on('event', (e) => events.push(e))
	const result = await resend({
		...cross('remove'),
		destinationNamespace: slowProfile.namespace,
		destinationProfile: slowProfile,
		maxSeconds: 1,
	})
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'time-limit',
		examined: 0,
		sent: 0,
		removed: 0,
	})
	expect(events).toContainEqual(
		expect.objectContaining({
			type: 'device-code',
			operationId: result.operationId,
			code: 'OFFLINE-RECOVERY',
		}),
	)
	expect((await peek()).items).toHaveLength(1)
})
it('reports destination authentication denial before accepting a source receiver', async () => {
	await start()
	await seed(['one'])
	const denied = {
		...destinationProfile,
		namespace: 'recovery-denied.fixture.servicebus.windows.net',
	}
	const result = await resend({
		...cross('remove'),
		destinationNamespace: denied.namespace,
		destinationProfile: denied,
	})
	expect(result).toMatchObject({
		status: 'failed',
		examined: 0,
		sent: 0,
		removed: 0,
		transfers: [],
	})
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect((await peek()).items).toHaveLength(1)
})
it('routes subscription transfer dead letters to a topic in the other namespace, preserving session and requested message IDs', async () => {
	await start()
	const target = { kind: 'subscription', name: 'audit', topicName: 'order-events' } as const
	const destination = { kind: 'topic', name: 'order-events' } as const
	const result = await resend({
		...cross('remove', target, destination),
		subQueue: 'transfer-dead-letter',
		maxMessages: 1,
		idPolicy: 'preserve',
	})
	expect(result).toMatchObject({
		sent: 1,
		removed: 1,
		outgoingMessageId: 'transfer-001',
		subQueue: 'transfer-dead-letter',
	})
	await openDestination()
	for (const name of ['billing', 'audit']) {
		const messages = (await peek({ ...target, name }, 'active')).items
		expect(messages).toHaveLength(1)
		expect(messages[0]).toMatchObject({ messageId: 'transfer-001', sessionId: 'session-001' })
	}
})
it('retains successful counts when destination cleanup fails', async () => {
	await start()
	await seed(['one'])
	const profile = {
		...destinationProfile,
		namespace: 'recovery-cleanup.fixture.servicebus.windows.net',
	}
	const result = await resend({
		...cross('remove'),
		destinationNamespace: profile.namespace,
		destinationProfile: profile,
	})
	expect(result).toMatchObject({ sent: 1, removed: 1, uncertain: 0, copiedNotRemoved: 0 })
	expect(result.cleanupWarning).toContain('Destination connection cleanup')
	expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('honors a message limit and does not send an unprojectable message', async () => {
	await start()
	await seed(['one', 'two'])
	const result = await resend({ ...cross('remove'), maxMessages: 1 })
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'message-limit',
		examined: 1,
		sent: 1,
		removed: 1,
	})
	expect((await peek()).items).toHaveLength(1)
	expect(await resend(cross('keep', { kind: 'queue', name: 'orders' }))).toMatchObject({
		status: 'failed',
		sent: 0,
		removed: 0,
		uncertain: 0,
	})
})
it('uses independent send/complete even when same-namespace transaction support would reject the destination', async () => {
	await start()
	await seed(['one'])
	expect(
		await resend(cross('remove', source, { kind: 'queue', name: 'reject-replay' })),
	).toMatchObject({ sent: 1, removed: 1, uncertain: 0 })
})
it('bounds receipt metadata before dispatch even for heavily escaped message IDs', async () => {
	await start()
	for (let batch = 0; batch < 45; batch++)
		await seed(
			Array.from(
				{ length: 10 },
				(_, i) => `${batch}-${String(i).padStart(2, '0')}-` + '\u0001'.repeat(120),
			),
		)
	const result = await resend({
		...cross('keep'),
		maxMessages: 1000,
		idPolicy: 'preserve',
		maxSeconds: 30,
	})
	expect(result).toMatchObject({
		status: 'limited',
		reason: 'receipt-limit',
		removed: 0,
		uncertain: 0,
	})
	expect(result.sent).toBeLessThan(450)
	expect(result.sent).toBeGreaterThan(0)
	expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(700000)
	expect(result.transfers).toHaveLength(result.sent)
}, 30000)
