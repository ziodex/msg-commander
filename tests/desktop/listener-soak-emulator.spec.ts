import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { DesktopRecovery } from './support/recovery'
import { RecoveryHarness } from '../emulator/support/recovery-harness'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'

test.skip(
	process.platform !== 'win32' ||
		process.env.COMMANDER_PACKAGED !== '1' ||
		process.env.COMMANDER_EMULATOR !== '1' ||
		process.env.COMMANDER_LISTENER_SOAK !== '1',
	'Windows package, Docker and listener endurance opt-in required.',
)

test('renders a sustained multi-session listener with bounded history, inspection and resource samples', async () => {
	const seconds = Number(process.env.COMMANDER_SOAK_SECONDS ?? '300')
	expect(seconds).toBeGreaterThanOrEqual(60)
	expect(seconds).toBeLessThanOrEqual(7200)
	test.setTimeout((seconds + 120) * 1000)
	const run = `listener-soak-${seconds}s-${randomUUID()}`
	const desktop = new DesktopRecovery()
	const isolated = process.env.COMMANDER_RECOVERY_ISOLATED === '1'
	desktop.harness = new RecoveryHarness({
		requiresSession: true,
		...(isolated ? { amqpPort: 15672, managementPort: 15300 } : {}),
	})
	const samples: Awaited<ReturnType<DesktopRecovery['resources']>>[] = []
	const snapshots: {
		cycle: number
		sent: number
		retained: number
		sessions: number
		progress: string
	}[] = []
	let cycles = 0,
		sent = 0,
		shutdownMs = 0
	const started = Date.now()
	try {
		await desktop.start()
		// Reload the saved profile, then exercise the renderer's real connection and listener stores.
		await desktop.call('disconnectNamespace', desktop.request())
		await desktop.page.reload()
		await desktop.page
			.locator('.connection-item')
			.filter({ hasText: 'Docker recovery' })
			.click()
		await desktop.page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
		await desktop.page
			.getByLabel('Filter loaded entities', { exact: true })
			.fill(desktop.harness.queue.name)
		await desktop.page
			.getByRole('button', {
				name: `${desktop.harness.queue.name} Sessions Active`,
				exact: true,
			})
			.click()
		await desktop.page.getByRole('button', { name: 'Listen for messages', exact: true }).click()
		const dialog = desktop.page.getByRole('dialog', {
			name: 'Background message listener',
			exact: true,
		})
		await dialog.getByLabel('Listener session selection').selectOption('next-available')
		await dialog.getByLabel('Listener settlement mode').selectOption('auto-complete')
		await dialog.getByLabel('Listener concurrent sessions').fill('3')
		await dialog.getByLabel('Listener session idle time').fill('1')
		await dialog.getByLabel('Listener maximum messages').fill('100000')
		await dialog.getByLabel('Listener run time').fill(String(seconds + 60))
		await dialog
			.getByRole('checkbox', {
				name: 'I reviewed the source, settlement mode and limits.',
				exact: true,
			})
			.check()
		await dialog.getByRole('button', { name: 'Start listener', exact: true }).click()
		await expect(dialog.locator('.listener-counters')).toContainText('0 received')
		samples.push(await desktop.resources())
		const activeStart = Date.now()
		while (Date.now() - activeStart < seconds * 1000) {
			// The independent synthetic producer uses one receipt per send. Rotate it explicitly
			// before the 1,000-receipt connection cap; the listener keeps its original connection.
			if (cycles > 0 && cycles % 50 === 0) await desktop.harness.reconnectObserver()
			const body = JSON.stringify({
				cycle: cycles,
				exact: '9007199254740993',
				payload: 'x'.repeat(cycles % 5 === 0 ? 65536 : 4096),
			})
			for (let session = 0; session < 3; session++) {
				for (let index = 0; index < 4; index++) {
					const result = await desktop.harness.observer.request('sb.send', {
						...desktop.harness.control(),
						target: desktop.harness.queue as { kind: 'queue'; name: string },
						draft: {
							...emptyDraft(Buffer.from(body).toString('base64')),
							subject: `Cycle-${cycles}`,
							contentType: 'application/json',
							messageId: `${cycles}-${session}-${index}`,
							sessionId: `cycle-${cycles}-session-${session}`,
						},
					})
					expect(result.status).toBe('confirmed')
					sent++
				}
			}
			await expect(dialog.locator('.listener-counters > span').nth(1)).toHaveText(
				`${sent} completed`,
				{ timeout: 20000 },
			)
			await expect(dialog.locator('.listener-counters > span').nth(2)).toHaveText('0 failed')
			await expect(dialog.locator('.listener-counters > span').nth(3)).toHaveText(
				'0 uncertain',
			)
			const retained = await dialog.getByRole('article').count()
			const sessions = await dialog
				.getByRole('region', { name: 'Session progress' })
				.locator('tbody tr')
				.count()
			expect(retained).toBeLessThanOrEqual(100)
			expect(sessions).toBeLessThanOrEqual(100)
			if (sent > 100) expect(retained).toBe(100)
			if (cycles % 12 === 0) {
				await dialog
					.getByRole('article')
					.first()
					.getByRole('button', { name: 'Inspect listener message', exact: true })
					.click()
				const inspector = desktop.page.getByRole('dialog', {
					name: 'Inspect listener message',
					exact: true,
				})
				await expect(
					inspector.getByRole('heading', { name: `Cycle-${cycles}`, exact: true }),
				).toBeVisible()
				// Bodies larger than the initial 64 KiB range deliberately stay unformatted until loaded.
				const more = inspector.getByRole('button', { name: 'Load more bytes', exact: true })
				if (await more.count()) await more.click()
				await expect(
					inspector.getByRole('button', { name: 'JSON', exact: true }),
				).toHaveAttribute('aria-pressed', 'true')
				await expect(inspector.getByTestId('message-body')).toContainText(
					'9007199254740993',
				)
				await inspector.getByRole('button', { name: 'Close', exact: true }).click()
				await dialog.getByRole('button', { name: 'Close', exact: true }).click()
				await desktop.page
					.getByRole('button', { name: 'View listener', exact: true })
					.click()
			}
			expect((await desktop.harness.peek()).items).toHaveLength(0)
			snapshots.push({
				cycle: cycles,
				sent,
				retained,
				sessions,
				progress: await dialog
					.getByRole('region', { name: 'Session progress' })
					.innerText(),
			})
			samples.push(await desktop.resources())
			cycles++
			await mkdir('artifacts/beta-recovery', { recursive: true })
			await writeFile(
				`artifacts/beta-recovery/${run}-progress.json`,
				JSON.stringify({ seconds, cycles, sent, samples, snapshots }, null, 2),
			)
			await desktop.page.waitForTimeout(5000)
		}
		const warm = samples[Math.min(3, samples.length - 1)]!,
			last = samples.at(-1)!
		expect(Math.max(...samples.map((sample) => sample.privateBytes))).toBeLessThan(
			1536 * 1024 * 1024,
		)
		expect(Math.max(...samples.map((sample) => sample.handles))).toBeLessThan(12000)
		expect(last.privateBytes - warm.privateBytes).toBeLessThan(256 * 1024 * 1024)
		expect(last.handles - warm.handles).toBeLessThan(160)
		const stopping = Date.now()
		await dialog.getByRole('button', { name: 'Stop listener', exact: true }).click()
		await expect(dialog.getByRole('status').first()).toContainText('stopped', {
			timeout: 10000,
		})
		const stopMs = Date.now() - stopping
		await desktop.page.screenshot({ path: `artifacts/beta-recovery/${run}.png` })
		snapshots.push({
			cycle: cycles,
			sent,
			retained: await dialog.getByRole('article').count(),
			sessions: await dialog
				.getByRole('region', { name: 'Session progress' })
				.locator('tbody tr')
				.count(),
			progress: `Stopped in ${stopMs}ms. ${await dialog.getByRole('status').first().innerText()}`,
		})
		const backend = last.processes.find((process) => process.name === 'MsgCommander.Host')!
		expect(backend).toBeDefined()
		const closing = Date.now()
		await desktop.app!.close()
		desktop.app = undefined
		shutdownMs = Date.now() - closing
		expect(shutdownMs).toBeLessThan(10000)
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
					shutdownMs,
					samples,
					snapshots,
				},
				null,
				2,
			),
		)
		await desktop.close()
	}
})
