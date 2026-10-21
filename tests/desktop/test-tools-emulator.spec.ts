import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

test.skip(process.env.COMMANDER_EMULATOR !== '1', 'Opt-in Docker test tools integration.')

test('runs concurrent send/receive batches and reviews latency against Docker through the desktop', async () => {
	test.setTimeout(90000)
	const directory = await mkdtemp(join(tmpdir(), 'commander-tools-emulator-'))
	let app: ElectronApplication | undefined
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		const executable = process.env.COMMANDER_PACKAGED_EXECUTABLE
		app = await electron.launch({
			...(executable ? { executablePath: resolve(executable) } : {}),
			args: [...(executable ? [] : ['.']), `--user-data-dir=${directory}`],
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
		const queue = `tools-${randomUUID()}`
		let dialog = page.getByRole('dialog')
		await dialog.getByLabel('Entity name', { exact: true }).fill(queue)
		await dialog.getByLabel('Default message TTL', { exact: true }).fill('01:00:00')
		await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
		await expect(dialog).toHaveCount(0)
		await page.getByRole('button', { name: 'Actions', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Test jobs…', exact: true }).click()
		dialog = page.getByRole('dialog', { name: 'Test job', exact: true })
		await dialog.getByLabel('Test workers', { exact: true }).fill('3')
		await dialog.getByLabel('Test batch size', { exact: true }).fill('5')
		await dialog.getByLabel('Test message count', { exact: true }).fill('31')
		await dialog.getByLabel('Test time limit', { exact: true }).fill('30')
		await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		const result = dialog.getByRole('region', { name: 'Test job result', exact: true })
		await expect(result).toContainText('31 sends confirmed', { timeout: 40000 })
		let timing = dialog.getByRole('table', { name: 'Operation latency', exact: true })
		await expect(timing.locator('tbody tr').first().locator('td').first()).toHaveText('7')
		await expect(timing.locator('tbody tr').first().locator('td').nth(4)).toHaveText(/\d+\.\d+/)
		await dialog.getByText('Worker details', { exact: true }).click()
		await expect(
			dialog
				.getByRole('table', { name: 'Test worker results', exact: true })
				.locator('tbody tr'),
		).toHaveCount(3)
		await page.screenshot({ path: 'artifacts/modern-test-tools-send.png' })
		await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
		await dialog.getByLabel('Test job type', { exact: true }).selectOption('receive')
		await dialog.getByLabel('Test message count', { exact: true }).fill('23')
		await dialog.getByLabel('Test batch size', { exact: true }).fill('4')
		await dialog
			.getByRole('checkbox', { name: /I understand this permanently completes/ })
			.check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect(result).toContainText('23 received; 23 completions confirmed.', {
			timeout: 40000,
		})
		timing = dialog.getByRole('table', { name: 'Operation latency', exact: true })
		await expect(
			timing.locator('tbody tr').filter({ hasText: 'Complete' }).locator('td').first(),
		).toHaveText('23')
		await page.screenshot({ path: 'artifacts/modern-test-tools-receive.png' })
		await expect(
			dialog.getByRole('button', { name: 'Prepare another test job', exact: true }),
		).toBeEnabled()
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(0)
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		await expect(
			page.getByRole('table', { name: 'Messages', exact: true }).locator('tbody tr'),
		).toHaveCount(8)
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
