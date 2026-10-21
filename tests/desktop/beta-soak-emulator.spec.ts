import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DesktopRecovery } from './support/recovery'
import type { TestJobResult } from '../../src/shared/contracts/service-bus/test-jobs'

test.skip(
	process.platform !== 'win32' ||
		process.env.COMMANDER_PACKAGED !== '1' ||
		process.env.COMMANDER_EMULATOR !== '1' ||
		process.env.COMMANDER_SOAK !== '1',
	'Windows package, Docker and soak opt-in required.',
)

test('sustains concurrent messaging, reconnects and shuts down active work within resource bounds', async () => {
	const seconds = Number(process.env.COMMANDER_SOAK_SECONDS ?? '180')
	expect(seconds).toBeGreaterThanOrEqual(60)
	expect(seconds).toBeLessThanOrEqual(7200)
	test.setTimeout((seconds + 120) * 1000)
	const run = `soak-${seconds}s-${randomUUID()}`
	const desktop = new DesktopRecovery()
	const samples: Awaited<ReturnType<DesktopRecovery['resources']>>[] = []
	const jobs: TestJobResult[] = []
	let cycles = 0,
		sent = 0,
		settled = 0,
		shutdownMs = 0
	const started = Date.now()
	try {
		await desktop.start()
		samples.push(await desktop.resources())
		const activeStart = Date.now()
		while (Date.now() - activeStart < seconds * 1000) {
			const count = 32
			const sending = desktop.job({
				maxMessages: count,
				workers: 4,
				batchSize: 1,
				maxSeconds: 40,
				delayMs: 1000,
				body: '',
				contentType: '',
				generator: {
					kind: 'binary',
					seed: cycles,
					sizeBytes: cycles % 5 === 0 ? 65536 : 4096,
				},
			})
			const send = await desktop.call('runTestJob', sending)
			jobs.push(send)
			expect(send).toMatchObject({ status: 'completed', sent: count, uncertain: 0 })
			sent += send.sent
			const page = await desktop.call('peekMessages', {
				...desktop.request(),
				target: desktop.harness.queue,
				subQueue: 'active',
				fromSequenceNumber: '0',
				maxMessages: 25,
			})
			expect(page.items).toHaveLength(25)
			const details = await desktop.call('inspectMessage', {
				...desktop.request(),
				snapshotId: page.items[0]!.snapshotId!,
			})
			expect(details.summary.bodySize).toBe(sending.generator.sizeBytes)
			const receive = await desktop.call(
				'runTestJob',
				desktop.job({
					mode: 'receive',
					body: '',
					contentType: '',
					maxMessages: count,
					workers: 4,
					batchSize: 8,
					maxSeconds: 40,
				}),
			)
			jobs.push(receive)
			expect(receive).toMatchObject({ status: 'completed', settled: count, uncertain: 0 })
			settled += receive.settled
			expect(
				await desktop.call('getTestJobResult', {
					...desktop.request(),
					operationId: receive.operationId,
				}),
			).toEqual(receive)
			expect((await desktop.harness.peek()).items).toHaveLength(0)
			await desktop.reconnect()
			expect((await desktop.call('listDeliveries', desktop.request())).items).toHaveLength(0)
			samples.push(await desktop.resources())
			cycles++
			await mkdir('artifacts/beta-recovery', { recursive: true })
			await writeFile(
				`artifacts/beta-recovery/${run}-progress.json`,
				JSON.stringify({ cycles, sent, settled, samples }, null, 2),
			)
		}
		expect(cycles).toBeGreaterThanOrEqual(5)
		const warm = samples[Math.min(3, samples.length - 1)]!,
			last = samples.at(-1)!
		expect(Math.max(...samples.map((sample) => sample.privateBytes))).toBeLessThan(
			1536 * 1024 * 1024,
		)
		expect(Math.max(...samples.map((sample) => sample.handles))).toBeLessThan(12000)
		expect(last.privateBytes - warm.privateBytes).toBeLessThan(256 * 1024 * 1024)
		expect(last.handles - warm.handles).toBeLessThan(160)

		const running = desktop.job({
			maxMessages: 100000,
			maxSeconds: 600,
			workers: 4,
			batchSize: 1,
			delayMs: 500,
		})
		const pending = desktop.call('runTestJob', running).catch(() => undefined)
		await expect
			.poll(async () => (await desktop.progress(running.id))?.sent ?? 0)
			.toBeGreaterThan(0)
		const backend = last.processes.find((p) => p.name === 'MsgCommander.Host')!
		expect(backend).toBeDefined()
		const stopping = Date.now()
		await desktop.app!.close()
		desktop.app = undefined
		await pending
		shutdownMs = Date.now() - stopping
		expect(shutdownMs).toBeLessThan(10000)
		// The owned backend must exit; a responsive UI alone would miss orphaned receivers.
		await expect
			.poll(() => {
				try {
					process.kill(backend.pid, 0)
					return true
				} catch {
					return false
				}
			})
			.toBe(false)
	} finally {
		await mkdir('artifacts/beta-recovery', { recursive: true })
		await writeFile(
			`artifacts/beta-recovery/${run}.json`,
			JSON.stringify(
				{
					seconds,
					elapsedMs: Date.now() - started,
					cycles,
					sent,
					settled,
					shutdownMs,
					samples,
					jobs,
				},
				null,
				2,
			),
		)
		await desktop.close()
	}
})
