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
const source = { kind: 'queue', name: 'empty' } as const
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
it.each(['single', 'next-available'] as const)(
	'records confirmed %s listener deferrals with the actual session scope',
	async (sessionMode) => {
		await connect()
		const target =
			sessionMode === 'single'
				? source
				: { kind: 'queue' as const, name: 'session-test-defer' }
		await send('recorded-listener', target, sessionMode === 'single' ? '' : 'defer-session')
		await host.request(
			'sb.listener.start',
			input({
				target,
				sessionMode,
				maxConcurrentSessions: sessionMode === 'single' ? 1 : 2,
				sessionIdleSeconds: 1,
			}),
		)
		const state = await until((value) => value.items.some((item) => item.state === 'active'))
		const item = state.items.find((item) => item.state === 'active')!
		await settle(state, 'defer')
		const scope = {
			...request(),
			target,
			subQueue: 'active' as const,
			sessionId: item.summary.sessionId ?? '',
		}
		expect(
			(await host.request('sb.defer.list', scope)).items.map((item) => item.sequenceNumber),
		).toContain(item.summary.sequenceNumber)
		if (scope.sessionId)
			expect(
				(await host.request('sb.defer.list', { ...scope, id: randomUUID(), sessionId: '' }))
					.total,
			).toBe(0)
		await stop(state.listenerId)
		const held = await host.request('sb.receive', {
			...scope,
			id: randomUUID(),
			maxMessages: 1,
			waitSeconds: 1,
			deferredSequence: item.summary.sequenceNumber,
		})
		expect(held.items[0]?.summary.sequenceNumber).toBe(item.summary.sequenceNumber)
		expect((await host.request('sb.defer.list', { ...scope, id: randomUUID() })).total).toBe(0)
	},
)
it('validates listener settings and guards interactive ownership and sessions before receiving', async () => {
	await connect()
	const value = input()
	for (const bad of [
		{ ...value, mode: 'bad' as never },
		{ ...value, maxSeconds: 0 },
		{ ...value, maxMessages: 100001 },
		{ ...value, maxMessages: 1001 },
		{ ...value, maxLockSeconds: 0 },
		{ ...value, target: { kind: 'topic', name: 'order-events' } as never },
		{ ...value, sessionId: 'not-a-session' },
	])
		await expect(host.request('sb.listener.start', bad)).rejects.toThrow()
	expect(listenerStartSchema.safeParse({ ...value, extra: true }).success).toBe(false)
	await expect(
		host.request('sb.listener.start', input({ target: { kind: 'queue', name: 'sessions' } })),
	).rejects.toThrow('session ID')
	await host.request('sb.receive', {
		...request(),
		target: source,
		subQueue: 'active',
		maxMessages: 1,
		waitSeconds: 1,
		sessionId: '',
	})
	await expect(host.request('sb.listener.start', value)).rejects.toThrow('Close the current')
})
it('keeps browsing and sending responsive while a manual listener holds one delivery and preserves exact inspection', async () => {
	await connect()
	const start = input()
	await host.request('sb.listener.start', start)
	await send('first')
	const state = await until((s) => s.received === 1 && s.items.length === 1)
	await send('second')
	expect((await peek()).items).toHaveLength(2)
	expect((await get())!.received).toBe(1)
	const details = await host.request('sb.inspect', {
		...request(),
		snapshotId: state.items[0].summary.snapshotId!,
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
				snapshotId: state.items[0].summary.snapshotId!,
				offset: 0,
				count: 65536,
			})
		).base64,
	).toBe('AP9B')
	expect((await host.request('sb.listener.start', start)).listenerId).toBe(start.id)
	await expect(host.request('sb.listener.start', input())).rejects.toThrow('Stop the current')
	await expect(host.request('sb.listener.start', { ...start, maxMessages: 4 })).rejects.toThrow(
		'different settings',
	)
	await expect(
		host.request('sb.receive', {
			...request(),
			target: source,
			subQueue: 'active',
			maxMessages: 1,
			waitSeconds: 1,
			sessionId: '',
		}),
	).rejects.toThrow('Stop the listener')
	await settle(state)
	const next = await until((s) => s.received === 2 && s.items.some((i) => i.state === 'active'))
	expect(next.completed).toBe(1)
	expect(next.items.find((i) => i.state === 'active')!.summary.messageId).toBe('second')
	const final = await stop(start.id)
	expect(final.status).toBe('stopped')
	expect(final.items[0].state).toBe('released')
	expect((await peek()).items.map((i) => i.messageId)).toEqual(['second'])
	expect((await stop(start.id)).completed).toBe(1)
})
it.each(['abandon', 'dead-letter', 'defer'] as const)(
	'manually %s settles through the listener and never repeats an operation ID',
	async (action) => {
		await connect()
		await send('review')
		await host.request('sb.listener.start', input({ maxMessages: 1 }))
		const state = await until((s) => s.received === 1 && s.items.length === 1)
		const value = {
			...request(),
			listenerId: state.listenerId,
			deliveryId: state.items[0].deliveryId,
			action,
			reason: 'Test',
			description: 'Reason',
		}
		await host.request('sb.listener.settle', value)
		await until((s) => s.status === 'limited')
		expect((await host.request('sb.listener.settle', value)).received).toBe(1)
		await expect(
			host.request('sb.listener.settle', { ...value, action: 'complete' }),
		).rejects.toThrow('different input')
		const page = await peek(source, action === 'dead-letter' ? 'dead-letter' : 'active')
		expect(page.items[0].messageId).toBe('review')
	},
)
it('automatically completes within message/time limits and bounds history to 100 rows', async () => {
	await connect()
	for (let i = 0; i < 105; i++) await send(`entry-${i}`)
	const start = input({ mode: 'auto-complete', maxMessages: 105 })
	await host.request('sb.listener.start', start)
	const final = await until((s) => s.status === 'limited')
	expect(final).toMatchObject({ received: 105, completed: 105, failed: 0, evicted: 5 })
	expect(final.items).toHaveLength(100)
	expect(final.items.every((i) => i.state === 'completed')).toBe(true)
	expect(final.items.at(-1)!.summary.messageId).toBe('entry-5')
	expect((await peek()).items).toHaveLength(0)
	await host.request('sb.listener.start', input({ maxSeconds: 1 }))
	expect((await until((s) => s.status === 'limited')).summary).toContain('Time limit')
})
it('does not restart a completed or replaced listener when a start request is repeated', async () => {
	await connect()
	const first = input()
	await host.request('sb.listener.start', first)
	await stop(first.id)
	expect((await host.request('sb.listener.start', first)).status).toBe('stopped')
	const second = input()
	await host.request('sb.listener.start', second)
	await stop(second.id)
	await send('must-stay-available')
	await expect(host.request('sb.listener.start', first)).rejects.toThrow('will not be restarted')
	expect((await get())!.listenerId).toBe(second.id)
	expect((await peek()).items.map((item) => item.messageId)).toEqual(['must-stay-available'])
})
it('renews message locks while waiting for review, then stops at the review limit without completing', async () => {
	await connect()
	await send('listener-renew')
	await host.request('sb.listener.start', input({ maxLockSeconds: 1 }))
	expect((await until((s) => s.renewed >= 1)).items[0].state).toBe('active')
	const final = await until((s) => s.status === 'limited')
	expect(final.completed).toBe(0)
	expect(final.summary).toContain('review time')
	expect((await peek()).items).toHaveLength(1)
})
it('stops on lock-renewal failure without deleting or leaking broker diagnostics', async () => {
	await connect()
	await send('listener-renew-fail')
	await host.request('sb.listener.start', input())
	const final = await until((s) => s.status === 'failed')
	expect(final).toMatchObject({ completed: 0, failed: 1, uncertain: 0 })
	expect(final.items[0].state).toBe('lock-lost')
	expect(JSON.stringify(final)).not.toContain('SECRET')
})
it('accepts a selected subscription session, renews its session lock, and releases ownership on stop', async () => {
	await connect()
	const target = { kind: 'subscription', name: 'audit', topicName: 'order-events' } as const
	await send('session-listener', target, 'listener-renew-session')
	await host.request('sb.listener.start', input({ target, sessionId: 'listener-renew-session' }))
	const state = await until((s) => s.received === 1 && s.renewed >= 1)
	await stop(state.listenerId)
	const lease = await host.request('sb.session.accept', {
		...request(),
		target,
		sessionId: 'listener-renew-session',
	})
	expect(lease.session?.status).toBe('active')
})
it('records ambiguous auto-completion once and stops without receiving the next message', async () => {
	await connect()
	await send('unknown-complete')
	await send('not-received')
	await host.request('sb.listener.start', input({ mode: 'auto-complete' }))
	const final = await until((s) => s.status === 'unknown')
	expect(final).toMatchObject({ received: 1, completed: 0, failed: 1, uncertain: 1 })
	expect(final.items[0].state).toBe('unknown')
	expect((await peek()).items.map((i) => i.messageId)).toEqual(['not-received'])
	expect(JSON.stringify(final)).not.toContain('SECRET')
})
it('stop cancels an idle receive without waiting for the namespace gate and disconnect invalidates the listener', async () => {
	await connect()
	const start = input({ target: { kind: 'queue', name: 'slow' } })
	await host.request('sb.listener.start', start)
	const controller = new AbortController()
	const foreground = host
		.request(
			'sb.send',
			{ ...request(), target: source, draft: { ...emptyDraft(''), messageId: 'slow-send' } },
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
it('stop during an unacknowledged completion reports uncertainty; late acknowledged completion remains confirmed', async () => {
	await connect()
	await send('purge-wait-complete')
	await host.request('sb.listener.start', input({ mode: 'auto-complete' }))
	const state = await until((s) => s.items[0]?.state === 'settling')
	expect(await stop(state.listenerId)).toMatchObject({
		status: 'unknown',
		completed: 0,
		uncertain: 1,
	})
	const other = { kind: 'queue', name: 'late-listener' } as const
	await send('purge-commit-late', other)
	await host.request('sb.listener.start', input({ target: other, mode: 'auto-complete' }))
	const late = await until((s) => s.items[0]?.state === 'settling')
	expect(await stop(late.listenerId)).toMatchObject({
		status: 'stopped',
		completed: 1,
		uncertain: 0,
	})
})
it('bounds retained body memory while preserving acknowledged completion counts', async () => {
	await connect()
	for (let i = 0; i < 70; i++)
		await send(`large-${i}`, source, '', Buffer.alloc(262144).toString('base64'))
	await host.request('sb.listener.start', input({ mode: 'auto-complete', maxMessages: 70 }))
	const final = await until((s) => s.status === 'limited')
	expect(final.completed).toBe(70)
	expect(final.retainedBytes).toBeLessThanOrEqual(16777216)
	expect(final.evicted).toBeGreaterThan(0)
	expect(final.items.length).toBeLessThan(70)
})

it('stops before automatically completing an oversized body', async () => {
	await connect()
	await send('listener-oversized')
	await host.request('sb.listener.start', input({ mode: 'auto-complete' }))
	const final = await until((s) => s.status === 'failed')
	expect(final).toMatchObject({ received: 1, completed: 0, failed: 1, retainedBytes: 0 })
	expect(final.summary).toContain('16 MiB')
})
