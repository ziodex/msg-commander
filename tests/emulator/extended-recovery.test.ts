import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { RecoveryHarness } from './support/recovery-harness'
import type { ListenerStart, ListenerState } from '../../src/shared/listeners'

// This broker has its own SQL container and fixed loopback ports. Never restart the shared broker.
const qualified = it.skipIf(process.env.COMMANDER_RECOVERY_EXTENDED !== '1')
const run = randomUUID()
let harness: RecoveryHarness | undefined
let evidence: Record<string, unknown> = {}
async function start(requiresSession = false, configuredQueue?: string) {
	evidence = { startedAt: new Date().toISOString() }
	harness = new RecoveryHarness({
		amqpPort: 15672,
		managementPort: 15300,
		requiresSession,
		configuredQueue,
	})
	await harness.start()
	return harness
}
const listenerInput = (
	test: RecoveryHarness,
	changes: Partial<ListenerStart> = {},
): ListenerStart => ({
	...test.request(),
	target: test.queue,
	sessionId: '',
	mode: 'manual',
	maxMessages: 20,
	maxSeconds: 180,
	maxLockSeconds: 120,
	...changes,
})
async function listenerUntil(
	test: RecoveryHarness,
	predicate: (state: ListenerState) => boolean,
	timeout = 15000,
) {
	let state: ListenerState | null = null
	await expect
		.poll(
			async () => {
				state = await test.host.request('sb.listener.status', test.request())
				return state !== null && predicate(state)
			},
			{ timeout, interval: 100 },
		)
		.toBe(true)
	return state!
}
const settle = (test: RecoveryHarness, deliveryId: string, observer = false) =>
	(observer ? test.observer : test.host).request('sb.settle', {
		...(observer ? test.control() : test.request()),
		deliveryId,
		action: 'complete',
		reason: '',
		description: '',
	})
afterEach(async (context) => {
	try {
		await harness?.close()
	} finally {
		await mkdir('artifacts/beta-recovery', { recursive: true })
		await writeFile(
			`artifacts/beta-recovery/extended-${run}-${context.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100)}.json`,
			JSON.stringify(
				{
					...evidence,
					finishedAt: new Date().toISOString(),
					testResult: context.task.result?.state,
				},
				null,
				2,
			),
		)
		harness = undefined
	}
})

qualified(
	'rejects an expired held lock after a prolonged outage and receives it again without replay',
	async () => {
		const test = await start()
		await test.seed()
		const held = (await test.receive()).items[0]!
		const disconnectedAt = Date.now()
		test.amqp.cut()
		await delay(Math.max(75000, Date.parse(held.lockedUntil) - Date.now() + 3000))
		test.amqp.restore()
		const redelivered = (await test.receive(true)).items[0]!
		expect(redelivered.summary.messageId).toBe(held.summary.messageId)
		expect(redelivered.summary.deliveryCount).toBeGreaterThan(held.summary.deliveryCount)
		const stale = await settle(test, held.deliveryId)
		expect(stale.status).toBe('rejected')
		expect(stale.summary).toMatch(/lock/i)
		expect((await test.host.request('sb.deliveries', test.request())).items[0]?.state).toBe(
			'lock-lost',
		)
		expect((await settle(test, redelivered.deliveryId, true)).status).toBe('confirmed')
		await test.reconnect()
		expect((await test.peek('active', false)).items).toHaveLength(0)
		expect((await test.host.request('sb.test.run', test.job({ maxMessages: 1 }))).sent).toBe(1)
		evidence = { ...evidence, outageMs: Date.now() - disconnectedAt, held, redelivered, stale }
	},
	130000,
)

qualified(
	'renews a real session lock and fences the lease after a lost renewal acknowledgement',
	async () => {
		const test = await start(true)
		await test.seed(1, 'renewal-session')
		const accepted = await test.host.request('sb.session.accept', {
			...test.request(),
			target: test.queue,
			sessionId: 'renewal-session',
		})
		const lease = accepted.session!
		await delay(1200)
		const renewed = await test.host.request('sb.session.renew', {
			...test.request(),
			leaseId: lease.leaseId,
		})
		evidence = { ...evidence, lease, renewed }
		expect(renewed.status).toBe('confirmed')
		const current = (await test.host.request('sb.deliveries', test.request())).session!
		evidence = { ...evidence, current }
		expect(Date.parse(current.lockedUntil)).toBeGreaterThan(Date.parse(lease.lockedUntil))
		const controller = new AbortController(),
			dropped = test.amqp.dropped
		test.amqp.loseResponses()
		const input = { ...test.request(), leaseId: lease.leaseId }
		const pending = test.host.request('sb.session.renew', input, {
			signal: controller.signal,
			waitForCancellation: true,
			timeout: 35000,
		})
		try {
			await expect.poll(() => test.amqp.dropped).toBeGreaterThan(dropped)
		} finally {
			controller.abort()
		}
		const unknown = await pending
		evidence = { ...evidence, unknown }
		expect(unknown.status).toBe('unknown')
		expect((await test.host.request('sb.deliveries', test.request())).session?.status).toBe(
			'unknown',
		)
		const bytes = test.amqp.forwarded
		const blocked = await test.host.request('sb.session.renew', {
			...test.request(),
			leaseId: lease.leaseId,
		})
		expect(blocked.status).toBe('rejected')
		expect(test.amqp.forwarded).toBe(bytes)
		test.amqp.restore()
		await test.reconnect()
		const fresh = (await test.receive(false, undefined, 'renewal-session')).items[0]!
		expect((await settle(test, fresh.deliveryId)).status).toBe('confirmed')
		expect((await test.peek()).items).toHaveLength(0)
		evidence = { ...evidence, lease, renewed, current, unknown, blocked, fresh }
	},
)

qualified(
	'renews a listener held lock, stops during network loss, and explicitly resumes',
	async () => {
		const test = await start()
		await test.seed()
		await test.host.request('sb.listener.start', listenerInput(test))
		const initial = await listenerUntil(test, (state) => state.received === 1)
		const renewed = await listenerUntil(test, (state) => state.renewed > 0, 55000)
		expect(Date.parse(renewed.items[0]!.lockedUntil)).toBeGreaterThan(
			Date.parse(initial.items[0]!.lockedUntil),
		)
		test.amqp.cut()
		const stopping = Date.now()
		const stopped = await test.host.request(
			'sb.listener.stop',
			{ ...test.request(), listenerId: initial.listenerId },
			{ timeout: 10000 },
		)
		const stopMs = Date.now() - stopping
		expect(stopMs).toBeLessThan(10000)
		expect(stopped.completed).toBe(0)
		expect(stopped.uncertain).toBe(0)
		expect(stopped.items[0]?.state).toBe('released')
		test.amqp.restore()
		await test.reconnect()
		await test.host.request(
			'sb.listener.start',
			listenerInput(test, { mode: 'auto-complete', maxMessages: 1 }),
		)
		const resumed = await listenerUntil(test, (state) => state.completed === 1, 70000)
		expect(resumed.uncertain).toBe(0)
		expect((await test.peek()).items).toHaveLength(0)
		evidence = { ...evidence, initial, renewed, stopped, stopMs, resumed }
	},
	150000,
)

qualified(
	'retains an unknown listener settlement after acknowledgement loss without repeating it',
	async () => {
		const test = await start()
		await test.seed()
		await test.host.request('sb.listener.start', listenerInput(test))
		const initial = await listenerUntil(test, (state) => state.received === 1)
		const input = {
			...test.request(),
			listenerId: initial.listenerId,
			deliveryId: initial.items[0]!.deliveryId,
			action: 'complete' as const,
			reason: '',
			description: '',
		}
		const controller = new AbortController(),
			dropped = test.amqp.dropped
		test.amqp.loseResponses()
		const pending = test.host.request('sb.listener.settle', input, {
			signal: controller.signal,
			waitForCancellation: true,
			timeout: 35000,
		})
		try {
			await expect.poll(() => test.amqp.dropped).toBeGreaterThan(dropped)
		} finally {
			controller.abort()
		}
		const result = await pending
		evidence = { ...evidence, initial, result }
		expect(result).toMatchObject({ status: 'unknown', completed: 0, uncertain: 1 })
		expect(result.items[0]?.state).toBe('unknown')
		expect((await test.peek()).items).toHaveLength(0)
		test.amqp.restore()
		await test.host.request('sb.listener.stop', {
			...test.request(),
			listenerId: initial.listenerId,
		})
		const bytes = test.amqp.forwarded
		await expect(
			test.host.request('sb.listener.settle', { ...input, id: randomUUID() }),
		).rejects.toThrow(/no longer available/i)
		expect(test.amqp.forwarded).toBe(bytes)
		await test.reconnect()
		expect(await test.host.request('sb.listener.status', test.request())).toBeNull()
		evidence = { ...evidence, initial, result }
	},
)

qualified(
	'completes multiple sessions after listener interruption and explicit reconnection',
	async () => {
		const test = await start(true)
		await test.seed(2, 'session-a')
		await test.seed(2, 'session-b')
		const input = listenerInput(test, {
			sessionMode: 'next-available',
			maxConcurrentSessions: 2,
			sessionIdleSeconds: 1,
		})
		await test.host.request('sb.listener.start', input)
		const before = await listenerUntil(
			test,
			(state) => state.received === 2 && state.activeSessions === 2,
		)
		expect(new Set(before.items.map((item) => item.summary.sessionId)).size).toBe(2)
		test.amqp.cut()
		const stopped = await test.host.request(
			'sb.listener.stop',
			{ ...test.request(), listenerId: before.listenerId },
			{ timeout: 10000 },
		)
		expect(stopped.completed).toBe(0)
		expect(stopped.activeSessions).toBe(0)
		test.amqp.restore()
		await test.reconnect()
		await test.host.request(
			'sb.listener.start',
			listenerInput(test, {
				mode: 'auto-complete',
				sessionMode: 'next-available',
				maxConcurrentSessions: 2,
				sessionIdleSeconds: 1,
				maxMessages: 4,
			}),
		)
		const resumed = await listenerUntil(test, (state) => state.completed === 4, 80000)
		expect(resumed.uncertain).toBe(0)
		expect(new Set(resumed.items.map((item) => item.summary.sessionId)).size).toBe(2)
		expect((await test.peek()).items).toHaveLength(0)
		evidence = { ...evidence, before, stopped, resumed }
	},
	115000,
)

qualified(
	'recovers a listener after restarting only the isolated Docker broker',
	async () => {
		const execute = promisify(execFile),
			container = 'msg-commander-recovery-servicebus-1'
		const { stdout } = await execute('docker', ['inspect', container])
		const inspected = JSON.parse(stdout)[0]
		expect(inspected.Config.Labels['com.docker.compose.project']).toBe('msg-commander-recovery')
		expect(inspected.Config.Labels['com.docker.compose.service']).toBe('servicebus')
		expect(inspected.HostConfig.PortBindings['5672/tcp'][0]).toEqual({
			HostIp: '127.0.0.1',
			HostPort: '15672',
		})
		const test = await start(false, 'desktop-messages')
		expect((await test.peek()).items).toHaveLength(0)
		await test.seed()
		await test.host.request('sb.listener.start', listenerInput(test))
		const before = await listenerUntil(test, (state) => state.received === 1)
		let stoppedBroker = false
		try {
			await execute('docker', ['stop', '--time', '2', container])
			stoppedBroker = true
			const stopped = await test.host.request(
				'sb.listener.stop',
				{ ...test.request(), listenerId: before.listenerId },
				{ timeout: 10000 },
			)
			expect(stopped.completed).toBe(0)
			await execute('docker', ['start', container])
			stoppedBroker = false
			await expect
				.poll(
					async () => {
						try {
							return (
								await fetch('http://127.0.0.1:15300/health', {
									signal: AbortSignal.timeout(1500),
								})
							).ok
						} catch {
							return false
						}
					},
					{ timeout: 120000, interval: 1000 },
				)
				.toBe(true)
			await test.reconnect()
			const afterRestart = await test.peek('active', false)
			// The emulator may reset messages on restart; record its behavior without claiming Azure durability.
			expect(afterRestart.items.length).toBeLessThanOrEqual(1)
			await test.seed()
			await test.host.request(
				'sb.listener.start',
				listenerInput(test, {
					mode: 'auto-complete',
					maxMessages: afterRestart.items.length + 1,
				}),
			)
			const resumed = await listenerUntil(
				test,
				(state) => state.completed === afterRestart.items.length + 1,
				20000,
			)
			expect(resumed.uncertain).toBe(0)
			expect((await test.peek('active', false)).items).toHaveLength(0)
			evidence = { ...evidence, container, before, stopped, afterRestart, resumed }
		} finally {
			if (stoppedBroker) await execute('docker', ['start', container])
		}
	},
	160000,
)
