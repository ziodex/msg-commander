import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	purgeConfirmation,
	purgeRequestSchema,
	type PurgeRequest,
	type PurgeProgress,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import type { PeekTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const target: PeekTarget = { kind: 'queue', name: 'orders' }
const subscription: PeekTarget = {
	kind: 'subscription',
	name: 'billing',
	topicName: 'order-events',
}
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
				namespace: 'fixture.servicebus.windows.net',
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
	destination: PeekTarget = target,
	subQueue: 'active' | 'dead-letter' = 'active',
): PurgeRequest {
	return {
		...request(),
		target: destination,
		subQueue,
		confirmation: purgeConfirmation('fixture.servicebus.windows.net', destination, subQueue),
		maxMessages: 100,
		maxSeconds: 10,
	}
}
const purge = (value = input(), signal?: AbortSignal) =>
	host.request('sb.purge', value, { signal, waitForCancellation: true, timeout: 20000 })
const send = (messageId: string, destination: PeekTarget = target, sessionId = '') =>
	host.request('sb.send', {
		...request(),
		target:
			destination.kind === 'subscription'
				? { kind: 'topic', name: destination.topicName }
				: destination,
		draft: { ...emptyDraft('eA=='), messageId, sessionId },
	})
const peek = (destination: PeekTarget = target, subQueue: 'active' | 'dead-letter' = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: destination,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
afterEach(async () => {
	await host?.stop()
})
it('routes actual SDK purge receivers with explicit completion, exclusive sessions and disposal', () => {
	expect(execFileSync('dotnet', [dll, '--purge-checks'], { encoding: 'utf8' })).toContain(
		'Purge adapter checks passed',
	)
})
it('requires exact destination/subqueue confirmation and bounds before any deletion', async () => {
	await start()
	const value = input()
	for (const bad of [
		{ ...value, confirmation: 'PURGE' },
		{ ...value, subQueue: 'dead-letter' as const },
		{ ...value, maxMessages: 0 },
		{ ...value, maxSeconds: 601 },
		{ ...value, target: { kind: 'topic', name: 'orders' } as never },
	])
		await expect(purge(bad)).rejects.toThrow()
	expect(purgeRequestSchema.safeParse({ ...value, arbitrary: true }).success).toBe(false)
	expect(purgeRequestSchema.safeParse({ ...value, maxMessages: 100001 }).success).toBe(false)
	expect((await purge()).completed).toBe(2)
})
it('purges main and DLQ independently, retains counts and never equates idle with empty', async () => {
	await start()
	const events: PurgeProgress[] = []
	host.on('event', (e) => {
		if (e.type === 'purge-progress') events.push(e)
	})
	const value = input()
	const result = await purge(value)
	expect(result).toMatchObject({
		completed: 2,
		received: 2,
		uncertain: 0,
		status: 'completed',
		reason: 'no-available-messages',
	})
	expect(result.summary).toContain('not guaranteed empty')
	expect((await peek()).items).toHaveLength(0)
	expect((await peek(target, 'dead-letter')).items).toHaveLength(1)
	expect((await purge(input(target, 'dead-letter'))).completed).toBe(1)
	expect((await peek(target, 'dead-letter')).items).toHaveLength(0)
	expect(await host.request('sb.purge.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	expect(events.filter((e) => e.operationId === value.id).at(-1)).toMatchObject({
		phase: 'finished',
		completed: 2,
	})
	expect(events.every((e) => e.elapsedMs >= 0 && e.completed <= e.received)).toBe(true)
})
it('isolates a subscription and its DLQ from other subscriptions', async () => {
	await start()
	const other: PeekTarget = { ...subscription, name: 'audit' }
	await send('fanout', subscription)
	expect((await purge(input(subscription))).completed).toBe(1)
	expect((await peek(other)).items).toHaveLength(1)
	// A separate topic name must not share the subscription bucket.
	const different: PeekTarget = { ...subscription, topicName: 'different-events' }
	expect((await purge(input(different, 'dead-letter'))).completed).toBe(1)
	expect((await peek(other)).items).toHaveLength(1)
})
it('enforces message caps and deduplicates repeated requests without another deletion', async () => {
	await start()
	const value = { ...input(), maxMessages: 1 }
	const result = await purge(value)
	expect(result).toMatchObject({ status: 'limited', reason: 'message-limit', completed: 1 })
	expect(await purge(value)).toEqual(result)
	await expect(purge({ ...value, maxMessages: 2 })).rejects.toThrow('different request')
	expect((await peek()).items).toHaveLength(1)
	expect((await purge()).completed).toBe(1)
})
it('leaves deferred and scheduled messages and preserves session state across all available sessions', async () => {
	await start()
	const sessions: PeekTarget = { kind: 'queue', name: 'sessions' }
	await send('first', sessions, 'one')
	await send('second', sessions, 'two')
	await send('locked', sessions, 'locked-session')
	expect((await purge(input(sessions))).completed).toBe(2)
	expect((await peek(sessions)).items.map((m) => m.sessionId)).toEqual(['locked-session'])
	const accepted = await host.request('sb.session.accept', {
		...request(),
		target: sessions,
		sessionId: 'state-only',
	})
	expect(
		(
			await host.request('sb.session.state', {
				...request(),
				leaseId: accepted.session!.leaseId,
			})
		).isSet,
	).toBe(true)
	await host.request('sb.session.release', { ...request(), leaseId: accepted.session!.leaseId })
	const batch = await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await host.request('sb.settle', {
		...request(),
		deliveryId: batch.items[0].deliveryId,
		action: 'defer',
		reason: '',
		description: '',
	})
	await host.request('sb.close-receiver', request())
	await host.request('sb.send.batch', {
		...request(),
		target,
		drafts: [{ ...emptyDraft('eA=='), messageId: 'scheduled' }],
		scheduledEnqueueTime: new Date(Date.now() + 3600000).toISOString(),
	})
	expect((await purge()).completed).toBe(1)
	expect((await peek()).items.map((m) => m.state).sort()).toEqual(['Deferred', 'Scheduled'])
})
it('refuses to purge while an interactive receiver or state-only session is owned', async () => {
	await start()
	const sessions: PeekTarget = { kind: 'queue', name: 'sessions' }
	const accepted = await host.request('sb.session.accept', {
		...request(),
		target: sessions,
		sessionId: 'state-only',
	})
	await expect(purge()).rejects.toThrow('Close the current')
	await host.request('sb.session.release', { ...request(), leaseId: accepted.session!.leaseId })
	await host.request('sb.receive', {
		...request(),
		target,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(purge()).rejects.toThrow('Close the current')
})
it('cancels after confirmed progress and returns truthful partial counts without further completion', async () => {
	await start()
	await send('first')
	await send('purge-wait-receive')
	const controller = new AbortController(),
		value = input()
	host.on('event', (e) => {
		if (e.type === 'purge-progress' && e.operationId === value.id && e.completed === 1)
			controller.abort()
	})
	const result = await purge(value, controller.signal)
	expect(result).toMatchObject({ status: 'cancelled', completed: 1, uncertain: 0 })
	expect((await peek()).items).toHaveLength(1)
	expect(await host.request('sb.purge.result', { ...request(), operationId: value.id })).toEqual(
		result,
	)
	expect((await host.request('sb.deliveries', request())).target).toBeNull()
})
it('stops on the deadline with partial counts', async () => {
	await start()
	await send('first')
	await send('purge-wait-receive')
	expect(await purge({ ...input(), maxSeconds: 1 })).toMatchObject({
		status: 'limited',
		reason: 'time-limit',
		completed: 1,
		uncertain: 0,
	})
})
it('retains an ambiguous completion and never retries it; known rejection stays distinct', async () => {
	await start()
	await send('unknown-complete')
	await send('untouched')
	const value = input(),
		result = await purge(value)
	expect(result).toMatchObject({ status: 'unknown', completed: 0, received: 1, uncertain: 1 })
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(await purge(value)).toEqual(result)
	expect((await peek()).items.map((m) => m.messageId)).toEqual(['untouched'])
	const rejected: PeekTarget = { kind: 'queue', name: 'rejected' }
	await send('purge-reject-complete', rejected)
	expect(await purge(input(rejected))).toMatchObject({
		status: 'failed',
		completed: 0,
		uncertain: 0,
	})
})
it('distinguishes cancellation during completion from acknowledgement winning cancellation', async () => {
	await start()
	for (const [messageId, expected] of [
		['purge-wait-complete', 'unknown'],
		['purge-commit-late', 'limited'],
	] as const) {
		const destination: PeekTarget = { kind: 'queue', name: messageId }
		await send(messageId, destination)
		const value = { ...input(destination), maxMessages: 1 },
			controller = new AbortController()
		const listener = (e: PurgeProgress) => {
			if (
				e.type === 'purge-progress' &&
				e.operationId === value.id &&
				e.phase === 'completing'
			)
				setTimeout(() => controller.abort(), 50)
		}
		host.on('event', listener)
		const result = await purge(value, controller.signal)
		host.off('event', listener)
		expect(result.status).toBe(expected)
		expect(result.completed).toBe(expected === 'limited' ? 1 : 0)
		expect(result.uncertain).toBe(expected === 'unknown' ? 1 : 0)
	}
})
it('reports permissions and cleanup failures, handles empty entities, and fences disconnected receipts', async () => {
	await start()
	expect(await purge(input({ kind: 'queue', name: 'purge-denied' }))).toMatchObject({
		status: 'failed',
		completed: 0,
	})
	expect(
		(await purge(input({ kind: 'queue', name: 'purge-cleanup-fail' }))).cleanupWarning,
	).toContain('cleanup')
	expect(await purge(input({ kind: 'queue', name: 'empty' }))).toMatchObject({
		completed: 0,
		uncertain: 0,
	})
	const value = input()
	await purge(value)
	await host.request('sb.disconnect', { connectionId })
	await expect(
		host.request('sb.purge.result', { ...request(), operationId: value.id }),
	).rejects.toThrow('Connection expired')
})

it('recovers a retained result after a desktop timeout without resubmitting the purge', async () => {
	await start()
	await send('purge-commit-late')
	const value = { ...input(), maxMessages: 1 }
	await expect(
		host.request('sb.purge', value, { timeout: 80, waitForCancellation: true }),
	).rejects.toMatchObject({ code: 'TIMEOUT' })
	const result = await host.request('sb.purge.result', { ...request(), operationId: value.id })
	expect(result).toMatchObject({ completed: 1, uncertain: 0, status: 'limited' })
	expect(await purge(value)).toEqual(result)
	expect((await peek()).items).toHaveLength(0)
})
