import { afterEach, expect, it } from 'vitest'
import type { ListenerState, ListenerStart } from '../../src/shared/listeners'
import { RecoveryHarness } from './support/recovery-harness'

let harness: RecoveryHarness
afterEach(async () => {
	await harness?.close()
})

async function start(requiresSession = false) {
	harness = new RecoveryHarness({ requiresSession })
	await harness.start()
}
const request = (patch: Partial<ListenerStart> = {}): ListenerStart => ({
	...harness.request(),
	target: harness.queue,
	mode: 'manual',
	sessionId: '',
	maxMessages: 4,
	maxSeconds: 20,
	maxLockSeconds: 20,
	...patch,
})
const status = () => harness.host.request('sb.listener.status', harness.request())
async function until(predicate: (state: ListenerState) => boolean) {
	let state: ListenerState | null = null
	await expect
		.poll(
			async () => {
				state = await status()
				return !!state && predicate(state)
			},
			{ timeout: 15000, interval: 100 },
		)
		.toBe(true)
	return state!
}

it('drains concurrent session listeners through production ports with a shared exact count', async () => {
	await start(true)
	await harness.seed(2, 'one')
	await harness.seed(2, 'two')
	const input = request({
		mode: 'auto-complete',
		sessionMode: 'next-available',
		maxConcurrentSessions: 2,
		sessionIdleSeconds: 1,
	})
	await harness.host.request('sb.listener.start', input)
	const result = await until(
		(state) => state.completed === 4 && !['running', 'stopping'].includes(state.status),
	)
	expect(result).toMatchObject({
		status: 'limited',
		received: 4,
		completed: 4,
		uncertain: 0,
		activeSessions: 0,
	})
	expect(result.sessionAcquisitions).toBeGreaterThanOrEqual(2)
	expect(
		result.sessions
			.filter((session) => session.completed > 0)
			.map((session) => session.sessionId)
			.sort(),
	).toEqual(['one', 'two'])
	expect((await harness.peek()).items).toHaveLength(0)
	await harness.reconnect()
	expect(await status()).toBeNull()
})

it('retains an uncertain listener settlement after acknowledgement loss without replay on reconnect', async () => {
	await start()
	await harness.seed()
	const input = request({ maxMessages: 1 })
	await harness.host.request('sb.listener.start', input)
	const held = await until((state) => state.items.some((item) => item.state === 'active'))
	const delivery = held.items.find((item) => item.state === 'active')!
	const settlement = {
		...harness.request(),
		listenerId: input.id,
		deliveryId: delivery.deliveryId,
		action: 'complete' as const,
		reason: '',
		description: '',
	}
	const forwarded = harness.amqp.forwarded,
		dropped = harness.amqp.dropped
	harness.amqp.loseResponses()
	const controller = new AbortController()
	const pending = harness.host.request('sb.listener.settle', settlement, {
		signal: controller.signal,
		waitForCancellation: true,
		timeout: 35000,
	})
	try {
		await expect
			.poll(() => harness.amqp.forwarded, { timeout: 5000 })
			.toBeGreaterThan(forwarded)
		await expect.poll(() => harness.amqp.dropped, { timeout: 5000 }).toBeGreaterThan(dropped)
	} finally {
		controller.abort()
	}
	const result = await pending
	expect(result).toMatchObject({ status: 'unknown', completed: 0, uncertain: 1 })
	expect(result.items).toContainEqual(
		expect.objectContaining({ deliveryId: delivery.deliveryId, state: 'unknown' }),
	)
	expect(await harness.host.request('sb.listener.settle', settlement)).toMatchObject({
		completed: 0,
		uncertain: 1,
	})
	expect((await harness.peek()).items).toHaveLength(0)
	harness.amqp.restore()
	await harness.host.request(
		'sb.listener.stop',
		{ ...harness.request(), listenerId: input.id },
		{ timeout: 35000 },
	)
	await harness.reconnect()
	expect(await status()).toBeNull()
	expect((await harness.peek()).items).toHaveLength(0)
})
