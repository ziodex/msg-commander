import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

test.skip(process.env.COMMANDER_EMULATOR !== '1', 'Opt-in Docker generator/settlement integration.')
test('previews modern payloads and reviews every settlement mode against Docker', async () => {
	test.setTimeout(120000)
	const directory = await mkdtemp(join(tmpdir(), 'commander-generators-'))
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
		const queue = `generators-${randomUUID()}`
		let dialog = page.getByRole('dialog')
		await dialog.getByLabel('Entity name', { exact: true }).fill(queue)
		await dialog.getByLabel('Default message TTL', { exact: true }).fill('01:00:00')
		await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
		await expect(dialog).toHaveCount(0)
		await page.getByRole('button', { name: 'Actions', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Test jobs…', exact: true }).click()
		dialog = page.getByRole('dialog', { name: 'Test job', exact: true })
		await dialog
			.getByLabel('Test payload generator', { exact: true })
			.selectOption('json-template')
		await dialog.getByRole('button', { name: 'Use example', exact: true }).click()
		await dialog.getByLabel('Test generator seed', { exact: true }).fill('42')
		await dialog.getByRole('button', { name: 'Preview payload', exact: true }).click()
		await expect(
			dialog.getByRole('region', { name: 'Test payload preview', exact: true }),
		).toContainText('"index": 1')
		await dialog.getByLabel('Test workers', { exact: true }).fill('3')
		await dialog.getByLabel('Test batch size', { exact: true }).fill('4')
		await dialog.getByLabel('Test message count', { exact: true }).fill('12')
		await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
		await page.screenshot({ path: 'artifacts/generators-preview-setup.png' })
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		const result = dialog.getByRole('region', { name: 'Test job result', exact: true })
		await expect(result).toContainText('12 sends confirmed', { timeout: 40000 })
		await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
		await dialog.getByLabel('Test job type', { exact: true }).selectOption('receive')
		await dialog.getByLabel('Test settlement mode', { exact: true }).selectOption('dead-letter')
		await dialog.getByLabel('Test dead-letter reason', { exact: true }).fill('BetaReview')
		await dialog.getByLabel('Test message count', { exact: true }).fill('5')
		await dialog.getByRole('checkbox', { name: /I understand this moves messages/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect(result).toContainText('5 dead-letters confirmed', { timeout: 40000 })
		await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
		await dialog.getByLabel('Test settlement mode', { exact: true }).selectOption('defer')
		await dialog.getByLabel('Test message count', { exact: true }).fill('4')
		await dialog.getByRole('checkbox', { name: /I understand this defers/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect(result).toContainText('4 deferrals confirmed', { timeout: 40000 })
		await dialog.getByText('Deferred sequences (4)', { exact: true }).click()
		await expect(dialog.getByLabel('Test deferred sequences', { exact: true })).toHaveValue(
			/^(\d+\n){3}\d+$/,
		)
		await page.screenshot({ path: 'artifacts/generators-deferred-result.png' })
		await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
		await dialog.getByLabel('Test settlement mode', { exact: true }).selectOption('abandon')
		await dialog.getByLabel('Test message count', { exact: true }).fill('20')
		await dialog.getByLabel('Test workers', { exact: true }).fill('1')
		await dialog.getByLabel('Test batch size', { exact: true }).fill('1')
		await dialog.getByRole('checkbox', { name: /I understand this releases messages/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect(result).toContainText('Stopped on redelivery', { timeout: 40000 })
		await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
		await dialog.getByLabel('Test job type', { exact: true }).selectOption('send')
		await dialog.getByLabel('Test payload generator', { exact: true }).selectOption('binary')
		await dialog.getByLabel('Test payload bytes', { exact: true }).fill('257')
		await dialog.getByRole('button', { name: 'Preview payload', exact: true }).click()
		await expect(
			dialog.getByRole('region', { name: 'Test payload preview', exact: true }),
		).toContainText('257 bytes')
		await dialog.getByLabel('Test message count', { exact: true }).fill('2')
		await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
		await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
		await expect(result).toContainText('2 sends confirmed', { timeout: 40000 })
		await expect(
			dialog.getByRole('button', { name: 'Prepare another test job', exact: true }),
		).toBeEnabled()
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(0)
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
