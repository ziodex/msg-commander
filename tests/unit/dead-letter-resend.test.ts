import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	resendRequestSchema,
	type ResendRequest,
	type ResendProgress,
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
const resend = (value = input(), signal?: AbortSignal) =>
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
it('validates source, destination, behavior and limits without requiring a confirmation phrase', async () => {
	await start()
	await seed()
	const value = input()
	for (const bad of [
		{ ...value, mode: 'invalid' as never },
		{ ...value, destination: { kind: 'queue', name: '' } as const },
		{ ...value, maxMessages: 1001 },
		{ ...value, maxSeconds: 0 },
		{ ...value, idPolicy: 'invalid' as never },
		{ ...value, source: { kind: 'topic', name: 'orders' } as never },
		{
			...value,
			destination: {
				kind: 'subscription',
				name: 'billing',
				topicName: 'order-events',
			} as never,
		},
	])
		await expect(resend(bad)).rejects.toThrow()
	expect(resendRequestSchema.safeParse(value).success).toBe(true)
	expect(resendRequestSchema.safeParse({ ...value, extra: true }).success).toBe(false)
	expect((await peek()).items).toHaveLength(2)
	expect((await peek(source, 'active')).items).toHaveLength(0)
})
it.each(['keep', 'remove'] as const)(
	'resends exact bytes/properties with new IDs in %s mode and retains an idempotent receipt',
	async (mode) => {
		await start()
		await seed()
		const before = await peek(),
			events: ResendProgress[] = []
		host.on('event', (e) => {
			if (e.type === 'resend-progress') events.push(e)
		})
		const value = input(mode),
			result = await resend(value)
		expect(result).toMatchObject({
			status: 'completed',
			examined: 2,
			sent: 2,
			removed: mode === 'keep' ? 0 : 2,
			uncertain: 0,
			reason: 'no-available-messages',
		})
		expect(result.sourceSequenceNumber).toBe(before.items[1].sequenceNumber)
		expect((await peek()).items).toHaveLength(mode === 'keep' ? 2 : 0)
		const active = await peek(source, 'active')
		expect(active.items).toHaveLength(2)
		expect(active.items.every((m) => !['first', 'second'].includes(m.messageId!))).toBe(true)
		const details = await host.request('sb.inspect', {
			...request(),
			snapshotId: active.items[0].snapshotId!,
		})
		expect(details.applicationProperties).toContainEqual({
			name: 'exact',
			type: 'int64',
			value: '9223372036854775807',
		})
		expect(details.applicationProperties.some((p) => p.name.startsWith('DeadLetter'))).toBe(
			false,
		)
		expect(
			(
				await host.request('sb.body', {
					...request(),
					snapshotId: active.items[0].snapshotId!,
					offset: 0,
					count: 65536,
				})
			).base64,
		).toBe('AP9B')
		expect(await resend(value)).toEqual(result)
		await expect(resend({ ...value, maxMessages: 1 })).rejects.toThrow('different request')
		expect(
			await host.request('sb.deadletters.result', { ...request(), operationId: value.id }),
		).toEqual(result)
		expect(events.at(-1)).toMatchObject({ phase: 'finished', sent: 2, removed: result.removed })
	},
)
it('preserves requested IDs, limits a run, and routes a subscription replay through its parent topic', async () => {
	await start()
	const target: PeekTarget = { kind: 'subscription', name: 'billing', topicName: 'order-events' }
	await seed(['original-a', 'original-b'], target)
	const value = {
		...input('remove', target, { kind: 'topic', name: 'order-events' }),
		maxMessages: 1,
		idPolicy: 'preserve' as const,
	}
	expect(await resend(value)).toMatchObject({
		sent: 1,
		removed: 1,
		status: 'limited',
		reason: 'message-limit',
		outgoingMessageId: 'original-a',
	})
	expect((await peek(target)).items.map((m) => m.messageId)).toEqual(['original-b'])
	expect((await peek(target, 'active')).items.map((m) => m.messageId)).toEqual(['original-a'])
	expect(
		(await peek({ ...target, name: 'audit' }, 'active')).items.map((m) => m.messageId),
	).toEqual(['original-a', 'original-b', 'original-a'])
})
it('uses the regular dead-letter receiver for session sources and keeps the session ID on resend', async () => {
	await start()
	const target: PeekTarget = { kind: 'queue', name: 'sessions' }
	await seed(['session-copy'], target, 'session-test')
	expect(await resend(input('remove', target))).toMatchObject({ sent: 1, removed: 1 })
	expect((await peek(source, 'active')).items[0].sessionId).toBe('session-test')
})
it.each([
	['keep', 'resend-reject-send'],
	['remove', 'reject-replay'],
] as const)(
	'stops a rejected %s send/transaction without removing the original',
	async (mode, name) => {
		await start()
		await seed(['original'])
		const result = await resend(input(mode, source, { kind: 'queue', name }))
		expect(result).toMatchObject({ status: 'failed', sent: 0, removed: 0, uncertain: 0 })
		expect(JSON.stringify(result)).not.toContain('SECRET')
		expect((await peek()).items).toHaveLength(1)
	},
)
it.each([
	['keep', 'resend-unknown-send'],
	['remove', 'unknown-replay'],
] as const)(
	'stops an uncertain %s outcome and records the outgoing ID without retrying',
	async (mode, name) => {
		await start()
		await seed()
		const value = input(mode, source, { kind: 'queue', name }),
			result = await resend(value)
		expect(result).toMatchObject({
			status: 'unknown',
			examined: 1,
			sent: 0,
			removed: 0,
			uncertain: 1,
		})
		expect(
			(await peek({ kind: 'queue', name }, 'active')).items.map((m) => m.messageId),
		).toEqual([result.outgoingMessageId])
		expect((await peek()).items).toHaveLength(mode === 'keep' ? 2 : 1)
		expect(await resend(value)).toEqual(result)
		expect((await peek({ kind: 'queue', name }, 'active')).items).toHaveLength(1)
	},
)
it('cancels before dispatch, enforces time limits, and treats cancelled in-flight sends as uncertain', async () => {
	await start()
	let value = input('remove', { kind: 'queue', name: 'resend-slow-receive' })
	const controller = new AbortController()
	const task = resend(value, controller.signal)
	setTimeout(() => controller.abort(), 100)
	expect(await task).toMatchObject({ status: 'cancelled', sent: 0, removed: 0, uncertain: 0 })
	value = { ...input('keep', { kind: 'queue', name: 'resend-slow-peek' }), maxSeconds: 1 }
	expect(await resend(value)).toMatchObject({ status: 'limited', reason: 'time-limit', sent: 0 })
	await seed(['first'])
	value = { ...input('keep', source, { kind: 'queue', name: 'resend-slow-send' }), maxSeconds: 1 }
	expect(await resend(value)).toMatchObject({
		status: 'unknown',
		sent: 0,
		removed: 0,
		uncertain: 1,
	})
	expect((await peek()).items).toHaveLength(1)
})
it.each(['keep', 'remove'] as const)(
	'retains a committed %s receipt after timeout/cancellation rather than resending',
	async (mode) => {
		await start()
		await seed(['late'])
		const value = {
			...input(mode, source, { kind: 'queue', name: 'resend-commit-late' }),
			maxMessages: 1,
		}
		await expect(
			host.request('sb.deadletters.resend', value, {
				timeout: 80,
				waitForCancellation: true,
			}),
		).rejects.toThrow()
		const result = await host.request('sb.deadletters.result', {
			...request(),
			operationId: value.id,
		})
		expect(result).toMatchObject({
			status: 'limited',
			sent: 1,
			removed: mode === 'keep' ? 0 : 1,
			uncertain: 0,
		})
		expect(await resend(value)).toEqual(result)
	},
)
it.each(['keep', 'remove'] as const)(
	'stops a %s feedback loop when a resent message immediately returns to the DLQ',
	async (mode) => {
		await start()
		const target: PeekTarget = { kind: 'queue', name: 'resend-feedback' }
		await host.request('sb.send', {
			...request(),
			target,
			draft: { ...emptyDraft('AP9B'), messageId: 'feedback-original' },
		})
		const result = await resend(input(mode, target, target))
		expect(result).toMatchObject({
			status: 'limited',
			reason: 'feedback-detected',
			sent: 1,
			removed: mode === 'keep' ? 0 : 1,
		})
		expect((await peek(target)).items).toHaveLength(mode === 'keep' ? 2 : 1)
	},
)
it('rejects binary application properties without changing source and blocks an owned receiver', async () => {
	await start()
	const result = await resend(input('keep', { kind: 'queue', name: 'orders' }))
	expect(result).toMatchObject({ status: 'failed', sent: 0, removed: 0 })
	expect(result.summary).toContain('binary application properties')
	await host.request('sb.receive', {
		...request(),
		target: source,
		subQueue: 'dead-letter',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(resend()).rejects.toThrow('Close the current')
	await host.request('sb.close-receiver', request())
	expect(await resend()).toMatchObject({ status: 'completed', sent: 0 })
	await host.request('sb.disconnect', { ...request() })
	await expect(resend()).rejects.toThrow('Connection expired')
})
