import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
test.skip(
	process.platform !== 'win32' ||
		process.env.COMMANDER_PACKAGED !== '1' ||
		process.env.COMMANDER_EMULATOR !== '1',
	'Windows package and Docker opt-in required.',
)
test('recovers from abrupt backend loss during a send test without automatic replay', async () => {
	test.setTimeout(90000)
	const directory = await mkdtemp(join(tmpdir(), 'commander-beta-recovery-'))
	let app: ElectronApplication | undefined
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		app = await electron.launch({
			executablePath: resolve(process.env.COMMANDER_PACKAGED_EXECUTABLE!),
			args: [`--user-data-dir=${directory}`],
			env,
		})
		const page = await app.firstWindow()
		await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
			timeout: 20000,
		})
		await page.getByRole('button', { name: 'New connection', exact: true }).click()
		await page.getByLabel('Local emulator', { exact: true }).check()
		await page.getByRole('button', { name: 'Save connection', exact: true }).click()
		await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
		await page.getByRole('button', { name: 'desktop-messages Active', exact: true }).click()
		await page.locator('.entity-admin > summary').click()
		await page.getByRole('button', { name: 'Create queue', exact: true }).click()
		const queue = `recovery-${randomUUID()}`
		let dialog = page.getByRole('dialog')
		await dialog.getByLabel('Entity name', { exact: true }).fill(queue)
		await dialog.getByLabel('Default message TTL', { exact: true }).fill('01:00:00')
		await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
		await expect(dialog).toHaveCount(0)
		await page.getByRole('button', { name: 'Actions', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Test jobs…', exact: true }).click()
		dialog = page.getByRole('dialog', { name: 'Test job', exact: true })
		await dialog.getByLabel('Test message count', { exact: true }).fill('100')
		await dialog.getByLabel('Test message delay', { exact: true }).fill('1000')
		await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect
			.poll(async () => Number(await dialog.getByRole('progressbar').getAttribute('value')))
			.toBeGreaterThan(0)
		const parent = await app.evaluate(() => process.pid)
		// Select only the backend owned by this isolated app, never another running preview.
		const { stdout } = await promisify(execFile)('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parent} AND Name = 'MsgCommander.Host.exe'" | Select-Object -ExpandProperty ProcessId`,
		])
		const pids = stdout.trim().split(/\s+/).map(Number)
		expect(pids).toHaveLength(1)
		expect(pids[0]).toBeGreaterThan(0)
		process.kill(pids[0])
		await expect(page.getByText('Backend connected', { exact: true })).not.toBeVisible()
		if (await dialog.count()) {
			await expect(
				dialog.getByRole('button', { name: 'Cancel test job', exact: true }),
			).toHaveCount(0)
			await page.keyboard.press('Escape')
			await expect(dialog).toHaveCount(0)
		}
		if (await page.getByRole('button', { name: 'Show Operations log', exact: true }).count())
			await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
		await expect(page.getByRole('region', { name: 'Operations', exact: true })).toContainText(
			'Final counts are unknown',
		)
		const restarted = await page.evaluate(() => window.commander.restartBackend())
		expect(restarted.ok).toBe(true)
		await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
		await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
		await page.getByRole('button', { name: `${queue} Active`, exact: true }).click()
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		const table = page.getByRole('table', { name: 'Messages', exact: true })
		await expect(table.locator('tbody tr').first()).toBeVisible()
		const first = await table.locator('tbody tr').allTextContents()
		expect(first.length).toBeGreaterThan(0)
		expect(first.length).toBeLessThan(100)
		// Observe longer than the configured batch delay to detect an unintended restart.
		await new Promise((resolve) => setTimeout(resolve, 1300))
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
		await expect(table.locator('tbody tr')).toHaveText(first)
		await page.screenshot({ path: 'artifacts/beta-backend-recovered.png' })
		const management = page.locator('.entity-admin')
		if (!(await management.evaluate((element) => (element as HTMLDetailsElement).open)))
			await management.locator('summary').click()
		await page.getByRole('button', { name: 'Delete queue', exact: true }).click()
		dialog = page.getByRole('dialog')
		await expect(dialog.locator('.write-destination')).toContainText(queue)
		await dialog.getByRole('checkbox', { name: /I understand this queue/ }).check()
		await dialog.getByRole('button', { name: 'Permanently delete queue', exact: true }).click()
		await expect(dialog).toHaveCount(0)
	} finally {
		await app?.close()
		await rm(directory, { recursive: true, force: true })
	}
})
