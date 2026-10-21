import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { RecoveryHarness } from './support/recovery-harness'

it.skipIf(process.env.COMMANDER_LONG_OUTAGE !== '1')(
	'retains local delivery state through an hour-long outage and recovers after broker expiry without replay',
	async () => {
		const seconds = Number(process.env.COMMANDER_OUTAGE_SECONDS ?? '3600')
		expect(seconds).toBeGreaterThanOrEqual(3600)
		expect(seconds).toBeLessThanOrEqual(7200)
		const run = `long-outage-${seconds}s-${randomUUID()}`
		const test = new RecoveryHarness({
			amqpPort: 25672,
			managementPort: 25300,
			messageTimeToLive: '01:00:00',
		})
		const pulses: { at: string; offlineMs: number; held: number; backendVersion: string }[] = []
		const result: Record<string, unknown> = {
			seconds,
			status: 'running',
			startedAt: new Date().toISOString(),
			pulses,
		}
		try {
			await expect
				.poll(
					async () => {
						try {
							return (
								await fetch('http://127.0.0.1:25300/health', {
									signal: AbortSignal.timeout(1500),
								})
							).ok
						} catch {
							return false
						}
					},
					{ timeout: 180000, interval: 2000 },
				)
				.toBe(true)
			await test.start()
			await test.seed()
			const held = (await test.receive()).items[0]!
			result.held = held
			test.amqp.cut()
			test.management.cut()
			await delay(100)
			const offlineStart = performance.now(),
				amqpBytes = test.amqp.forwarded,
				managementBytes = test.management.forwarded
			while (performance.now() - offlineStart < seconds * 1000) {
				await delay(Math.min(30000, seconds * 1000 - (performance.now() - offlineStart)))
				const hello = await test.host.request('host.hello', { protocolVersion: 1 })
				const current = await test.host.request('sb.deliveries', test.request())
				expect(current.items[0]?.summary.messageId).toBe(held.summary.messageId)
				expect(test.amqp.forwarded).toBe(amqpBytes)
				expect(test.management.forwarded).toBe(managementBytes)
				pulses.push({
					at: new Date().toISOString(),
					offlineMs: performance.now() - offlineStart,
					held: current.items.length,
					backendVersion: hello.version,
				})
				await mkdir('artifacts/beta-recovery', { recursive: true })
				await writeFile(
					`artifacts/beta-recovery/${run}-progress.json`,
					JSON.stringify(result, null, 2),
				)
			}
			result.offlineMs = performance.now() - offlineStart
			expect(result.offlineMs).toBeGreaterThanOrEqual(seconds * 1000)
			test.amqp.restore()
			test.management.restore()
			// The emulator caps TTL at one hour. This message has expired at recovery;
			// the separate 75-second case verifies redelivery after lock expiry.
			expect((await test.receive(true)).items).toHaveLength(0)
			const stale = await test.host.request('sb.settle', {
				...test.request(),
				deliveryId: held.deliveryId,
				action: 'complete',
				reason: '',
				description: '',
			})
			expect(stale.status).toBe('rejected')
			expect(stale.summary).toMatch(/lock/i)
			expect((await test.peek()).items).toHaveLength(0)
			await test.reconnect()
			expect((await test.host.request('sb.deliveries', test.request())).items).toHaveLength(0)
			const next = await test.host.request('sb.test.run', test.job({ maxMessages: 1 }))
			expect(next).toMatchObject({ status: 'completed', sent: 1, uncertain: 0 })
			const fresh = (await test.receive()).items[0]!
			expect(fresh.summary.messageId).not.toBe(held.summary.messageId)
			const completed = await test.host.request('sb.settle', {
				...test.request(),
				deliveryId: fresh.deliveryId,
				action: 'complete',
				reason: '',
				description: '',
			})
			expect(completed.status).toBe('confirmed')
			expect((await test.peek()).items).toHaveLength(0)
			Object.assign(result, {
				status: 'passed',
				brokerOutcome:
					'Original message expired under the emulator one-hour TTL; no durability claim',
				stale,
				completed,
				next,
			})
		} catch (error) {
			result.status = 'failed'
			result.error =
				error instanceof Error ? error.message : 'Long outage qualification failed'
			throw error
		} finally {
			await mkdir('artifacts/beta-recovery', { recursive: true })
			result.finishedAt = new Date().toISOString()
			await writeFile(`artifacts/beta-recovery/${run}.json`, JSON.stringify(result, null, 2))
			await test.close()
		}
	},
	(Number(process.env.COMMANDER_OUTAGE_SECONDS ?? '3600') + 240) * 1000,
)
