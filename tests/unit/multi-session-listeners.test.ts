import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import {
	listenerStartSchema,
	type ListenerStart,
	type ListenerState,
} from '../../src/shared/listeners'
import type { PeekTarget } from '../../src/shared/service-bus'
let host: Backend, connectionId: string
const source = { kind: 'queue', name: 'sessions' } as const
const request = () => ({ id: randomUUID(), connectionId })
async function connect() {
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
function input(overrides: Partial<ListenerStart> = {}): ListenerStart {
	return {
		...request(),
		target: source,
		mode: 'manual',
		sessionId: '',
		sessionMode: 'next-available',
		maxConcurrentSessions: 2,
		sessionIdleSeconds: 1,
		maxMessages: 1000,
		maxSeconds: 30,
		maxLockSeconds: 10,
		...overrides,
	}
}
async function send(
	messageId: string,
	target: PeekTarget = source,
	sessionId = '',
	bodyBase64 = 'AP9B',
) {
	return host.request('sb.send', {
		...request(),
		target: target.kind === 'subscription' ? { kind: 'topic', name: target.topicName } : target,
		draft: {
			...emptyDraft(bodyBase64),
			messageId,
			sessionId,
			properties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
		},
	})
}
const get = () => host.request('sb.listener.status', request())
async function until(predicate: (state: ListenerState) => boolean) {
	let state: ListenerState | null = null
	await expect
		.poll(
			async () => {
				state = await get()
				return !!state && predicate(state)
			},
			{ timeout: 8000, interval: 30 },
		)
		.toBe(true)
	return state!
}
const stop = (listenerId: string) => host.request('sb.listener.stop', { ...request(), listenerId })
const settle = (
	state: ListenerState,
	action: 'complete' | 'abandon' | 'dead-letter' | 'defer' = 'complete',
) =>
	host.request('sb.listener.settle', {
		...request(),
		listenerId: state.listenerId,
		deliveryId: state.items.find((i) => i.state === 'active')!.deliveryId,
		action,
		reason: 'Review',
		description: 'Fixture',
	})
const peek = (target: PeekTarget = source, subQueue: 'active' | 'dead-letter' = 'active') =>
	host.request('sb.peek', {
		...request(),
		target,
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
afterEach(async () => {
	await host?.stop()
})
it('rejects invalid concurrency, session modes and non-session sources before receiving', async () => {
	await connect()
	for (const patch of [
		{ maxConcurrentSessions: 0 },
		{ maxConcurrentSessions: 9 },
		{ sessionIdleSeconds: 0 },
		{ sessionIdleSeconds: 31 },
		{ sessionId: 'specific' },
		{ sessionMode: 'single' },
		{ sessionMode: 'other' },
	]) {
		const bad = { ...input(), ...patch } as ListenerStart
		expect(listenerStartSchema.safeParse(bad).success).toBe(false)
		await expect(host.request('sb.listener.start', bad)).rejects.toThrow()
	}
	await expect(
		host.request('sb.listener.start', input({ target: { kind: 'queue', name: 'empty' } })),
	).rejects.toThrow('session-enabled')
	expect(await get()).toBeNull()
})
it('owns at most two sessions, holds one delivery each, routes settlement and continues the other session', async () => {
	await connect()
	for (const [id, session] of [
		['a1', 'a'],
		['a2', 'a'],
		['b1', 'b'],
		['b2', 'b'],
		['c1', 'c'],
	])
		await send(id, source, session)
	const start = input()
	await host.request('sb.listener.start', start)
	const state = await until(
		(s) =>
			s.received === 2 &&
			s.sessions.length === 2 &&
			s.sessions.every((session) => session.pending === 1),
	)
	expect(state).toMatchObject({ activeSessions: 2, sessionAcquisitions: 2, completed: 0 })
	expect(state.sessions.map((s) => s.pending)).toEqual([1, 1])
	expect(new Set(state.items.map((i) => i.summary.sessionId)).size).toBe(2)
	const a = state.items.find((i) => i.summary.messageId === 'a1')!
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: a.summary.snapshotId!,
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'exact',
		type: 'int64',
		value: '9223372036854775807',
	})
	const ack = {
		...request(),
		listenerId: start.id,
		deliveryId: a.deliveryId,
		action: 'complete' as const,
		reason: '',
		description: '',
	}
	await Promise.all([
		host.request('sb.listener.settle', ack),
		host.request('sb.listener.settle', ack),
	])
	const next = await until(
		(s) => s.received === 3 && s.items.some((item) => item.summary.messageId === 'a2'),
	)
	expect(next.completed).toBe(1)
	expect(next.items.find((i) => i.summary.messageId === 'b1')?.state).toBe('active')
	expect(next.items.find((i) => i.summary.messageId === 'a2')?.state).toBe('active')
	await expect(host.request('sb.listener.settle', { ...ack, action: 'defer' })).rejects.toThrow(
		'reused',
	)
	expect((await peek()).items).toHaveLength(4)
	const final = await stop(start.id)
	expect(final.activeSessions).toBe(0)
	expect(final.sessions.every((s) => s.pending === 0)).toBe(true)
	const lease = await host.request('sb.session.accept', {
		...request(),
		target: source,
		sessionId: 'a',
	})
	expect(lease.session?.status).toBe('active')
})
it.each(['abandon', 'dead-letter', 'defer'] as const)(
	'records %s against only its owning session',
	async (action) => {
		await connect()
		await send('a', source, 'a')
		await send('b', source, 'b')
		const start = input({ maxMessages: 2 })
		await host.request('sb.listener.start', start)
		const state = await until((s) => s.received === 2 && s.items.length === 2)
		const sessionId = state.items[0].summary.sessionId
		await settle(state, action)
		const after = (await get())!
		const key =
			action === 'abandon'
				? 'abandoned'
				: action === 'dead-letter'
					? 'deadLettered'
					: 'deferred'
		expect(after.sessions.find((s) => s.sessionId === sessionId)?.[key]).toBe(1)
		expect(after.sessions.find((s) => s.sessionId !== sessionId)?.pending).toBe(1)
		expect(after.received).toBe(2)
		await stop(start.id)
	},
)
it('enforces a shared budget smaller than configured concurrency without releasing pending manual review', async () => {
	await connect()
	for (let i = 0; i < 10; i++) await send(`m${i}`, source, `s${i}`)
	const start = input({ maxConcurrentSessions: 8, maxMessages: 3 })
	await host.request('sb.listener.start', start)
	const state = await until((s) => s.received === 3)
	expect(state).toMatchObject({ status: 'running', activeSessions: 3, completed: 0 })
	for (const item of state.items)
		await host.request('sb.listener.settle', {
			...request(),
			listenerId: start.id,
			deliveryId: item.deliveryId,
			action: 'complete',
			reason: '',
			description: '',
		})
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({ received: 3, completed: 3, activeSessions: 0, uncertain: 0 })
	expect((await peek()).items).toHaveLength(7)
})
it('releases idle sessions to acquire others and leaves externally locked sessions alone', async () => {
	await connect()
	await send('locked', source, 'locked-session')
	for (const id of ['a', 'b', 'c']) await send(id, source, id)
	await host.request(
		'sb.listener.start',
		input({ mode: 'auto-complete', maxConcurrentSessions: 1, maxMessages: 3 }),
	)
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({ received: 3, completed: 3, sessionAcquisitions: 3 })
	expect(final.sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c'])
	expect((await peek()).items.map((i) => i.messageId)).toEqual(['locked'])
})
it('uses the selected subscription and renews its session without touching the other subscription', async () => {
	await connect()
	const target = { kind: 'subscription', name: 'audit', topicName: 'order-events' } as const
	await send('one', target, 'listener-renew-session')
	await host.request('sb.listener.start', input({ target, maxMessages: 1 }))
	const state = await until(
		(s) =>
			s.received === 1 && s.renewed >= 1 && s.items.some((item) => item.state === 'active'),
	)
	expect(state.sessions[0].renewed).toBeGreaterThanOrEqual(1)
	await settle(state)
	await until((s) => s.status === 'limited')
	expect((await peek(target)).items).toHaveLength(0)
	expect((await peek({ ...target, name: 'billing' })).items.map((i) => i.messageId)).toEqual([
		'one',
	])
})
it('times out with no available sessions, without claiming that the source is empty', async () => {
	await connect()
	await host.request(
		'sb.listener.start',
		input({ target: { kind: 'queue', name: 'session-test-idle' }, maxSeconds: 1 }),
	)
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({
		received: 0,
		sessionAcquisitions: 0,
		activeSessions: 0,
		uncertain: 0,
	})
	expect(final.summary).toContain('Time limit')
})
it('cancels pending session acquisition promptly and is idempotent on stop and start', async () => {
	await connect()
	const start = input({
		target: { kind: 'queue', name: 'session-test-slow-accept' },
		maxConcurrentSessions: 8,
	})
	await host.request('sb.listener.start', start)
	await until((s) => s.acceptingSessions === 8)
	const before = Date.now()
	const final = await stop(start.id)
	expect(Date.now() - before).toBeLessThan(2000)
	expect(final).toMatchObject({
		status: 'stopped',
		acceptingSessions: 0,
		activeSessions: 0,
		received: 0,
	})
	expect(await stop(start.id)).toEqual(final)
	expect(await host.request('sb.listener.start', start)).toEqual(final)
	await expect(
		host.request('sb.listener.start', { ...start, maxConcurrentSessions: 1 }),
	).rejects.toThrow('reused')
})
it('stops slow receiving and pending manual sessions together and releases their ownership', async () => {
	await connect()
	await send('slow', source, 'multi-slow-receive')
	await send('normal', source, 'normal')
	const start = input()
	await host.request('sb.listener.start', start)
	await until((s) => s.activeSessions === 2 && s.received === 1)
	const final = await stop(start.id)
	expect(final).toMatchObject({ status: 'stopped', received: 1, completed: 0, activeSessions: 0 })
	expect(final.items[0].state).toBe('released')
	const lease = await host.request('sb.session.accept', {
		...request(),
		target: source,
		sessionId: 'multi-slow-receive',
	})
	expect(lease.session?.status).toBe('active')
})
it('ends every session when one manual review limit expires', async () => {
	await connect()
	await send('a', source, 'a')
	await send('b', source, 'b')
	await host.request('sb.listener.start', input({ maxLockSeconds: 1 }))
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({ received: 2, completed: 0, activeSessions: 0 })
	expect(final.summary).toContain('review time')
	expect(final.items.every((i) => i.state === 'released')).toBe(true)
})
it.each(['multi-renew-fail', 'multi-cleanup-fail'])(
	'stops all workers and sanitizes a %s failure',
	async (session) => {
		await connect()
		await send('a', source, session)
		const start = input({ mode: 'auto-complete', maxMessages: 1 })
		await host.request('sb.listener.start', start)
		const final = await until((s) => s.status === 'failed')
		expect(final.activeSessions).toBe(0)
		expect(final.sessions[0].status).toBe('failed')
		expect(JSON.stringify(final)).not.toContain('SECRET')
	},
)
it('reports acquisition permission failure without retrying or retaining secrets', async () => {
	await connect()
	await host.request(
		'sb.listener.start',
		input({ target: { kind: 'queue', name: 'session-test-denied-accept' } }),
	)
	const final = await until((s) => s.status === 'failed')
	expect(final.received).toBe(0)
	expect(JSON.stringify(final)).not.toContain('SECRET')
})
it('keeps all in-flight uncertain settlements and stops without retrying them', async () => {
	await connect()
	for (const id of ['a', 'b', 'c']) await send('purge-wait-complete', source, id)
	const start = input({ mode: 'auto-complete', maxConcurrentSessions: 3 })
	await host.request('sb.listener.start', start)
	await until((s) => s.items.filter((i) => i.state === 'settling').length === 3)
	const final = await stop(start.id)
	expect(final).toMatchObject({
		status: 'unknown',
		received: 3,
		completed: 0,
		uncertain: 3,
		activeSessions: 0,
	})
	expect(final.sessions.every((s) => s.status === 'unknown' && s.uncertain === 1)).toBe(true)
	expect(final.items.every((i) => i.state === 'unknown')).toBe(true)
})
it('keeps a late acknowledged completion confirmed when stop races another worker', async () => {
	await connect()
	await send('purge-commit-late', source, 'late')
	await send('slow', source, 'multi-slow-receive')
	const start = input({ mode: 'auto-complete' })
	await host.request('sb.listener.start', start)
	await until((s) => s.items.some((i) => i.state === 'settling'))
	const final = await stop(start.id)
	expect(final).toMatchObject({
		status: 'stopped',
		received: 1,
		completed: 1,
		uncertain: 0,
		activeSessions: 0,
	})
	expect(final.sessions.find((s) => s.sessionId === 'late')?.completed).toBe(1)
})
it('bounds aggregate history while preserving a pending message in another session', async () => {
	await connect()
	await send('held', source, 'held')
	for (let i = 0; i < 104; i++) await send(`next-${i}`, source, 'stream')
	const start = input({ maxMessages: 105, maxLockSeconds: 60, maxSeconds: 60 })
	await host.request('sb.listener.start', start)
	let state = await until((s) => s.received === 2)
	for (let i = 0; i < 104; i++) {
		const item = state.items.find(
			(i) => i.state === 'active' && i.summary.sessionId === 'stream',
		)!
		await host.request('sb.listener.settle', {
			...request(),
			listenerId: start.id,
			deliveryId: item.deliveryId,
			action: 'complete',
			reason: '',
			description: '',
		})
		state = await until(
			(s) =>
				s.completed === i + 1 &&
				(i === 103 ||
					s.items.some((i) => i.state === 'active' && i.summary.sessionId === 'stream')),
		)
	}
	expect(state).toMatchObject({ received: 105, completed: 104, evicted: 5 })
	expect(state.items).toHaveLength(100)
	expect(state.items.find((i) => i.summary.messageId === 'held')?.state).toBe('active')
	await stop(start.id)
}, 30000)
it('bounds session progress and history under many sessions while enforcing the shared cap', async () => {
	await connect()
	for (let i = 0; i < 105; i++) await send(`m${i}`, source, `s${i}`)
	await host.request(
		'sb.listener.start',
		input({
			mode: 'auto-complete',
			maxConcurrentSessions: 8,
			maxMessages: 105,
			maxSeconds: 30,
		}),
	)
	let final: ListenerState | null = null
	await expect
		.poll(
			async () => {
				final = await get()
				return final?.status
			},
			{ timeout: 25000, interval: 100 },
		)
		.toBe('limited')
	expect(final!).toMatchObject({
		received: 105,
		completed: 105,
		sessionAcquisitions: 105,
		sessionHistoryEvicted: 5,
		activeSessions: 0,
		evicted: 5,
	})
	expect(final!.sessions).toHaveLength(100)
	expect(final!.items).toHaveLength(100)
}, 30000)
it('stops before completing an oversized message and retains no over-budget data', async () => {
	await connect()
	await send('listener-oversized', source, 'big')
	await host.request('sb.listener.start', input({ mode: 'auto-complete' }))
	const final = await until((s) => s.status === 'failed')
	expect(final).toMatchObject({ received: 1, completed: 0, retainedBytes: 0, uncertain: 0 })
	expect(final.summary).toContain('16 MiB')
})
it('shares the byte budget across concurrently completed sessions', async () => {
	await connect()
	for (let i = 0; i < 70; i++)
		await send(`large-${i}`, source, `s${i % 4}`, Buffer.alloc(262144).toString('base64'))
	await host.request(
		'sb.listener.start',
		input({ mode: 'auto-complete', maxConcurrentSessions: 4, maxMessages: 70 }),
	)
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({ received: 70, completed: 70, uncertain: 0, activeSessions: 0 })
	expect(final.retainedBytes).toBeLessThanOrEqual(16777216)
	expect(final.evicted).toBeGreaterThan(0)
	expect(final.sessions.reduce((n, s) => n + s.completed, 0)).toBe(70)
})
it('stop bypasses a busy foreground namespace operation and disconnect invalidates the multi-session job', async () => {
	await connect()
	await send('one', source, 'a')
	const start = input()
	await host.request('sb.listener.start', start)
	await until((s) => s.received === 1)
	const controller = new AbortController()
	const foreground = host
		.request(
			'sb.send',
			{
				...request(),
				target: source,
				draft: { ...emptyDraft(''), messageId: 'slow-send', sessionId: 'a' },
			},
			{ signal: controller.signal },
		)
		.catch(() => null)
	const before = Date.now()
	expect((await stop(start.id)).status).toBe('stopped')
	expect(Date.now() - before).toBeLessThan(2000)
	controller.abort()
	await foreground
	await host.request('sb.disconnect', { connectionId })
	await expect(get()).rejects.toThrow('expired')
})
it('active multi-session ownership guards interactive receiving and destructive operations', async () => {
	await connect()
	await send('one', source, 'a')
	const start = input()
	await host.request('sb.listener.start', start)
	await until((s) => s.received === 1)
	await expect(
		host.request('sb.session.accept', { ...request(), target: source, sessionId: 'b' }),
	).rejects.toThrow('listener')
	await expect(
		host.request('sb.receive', {
			...request(),
			target: source,
			subQueue: 'active',
			maxMessages: 1,
			waitSeconds: 1,
			sessionId: 'b',
		}),
	).rejects.toThrow('listener')
	await expect(host.request('sb.listener.start', input())).rejects.toThrow('Stop the current')
	expect((await peek()).items).toHaveLength(1)
	await stop(start.id)
})
