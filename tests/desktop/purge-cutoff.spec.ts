import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture executable is deliberately excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-service-bus-'))
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
		),
	)
	app = await electron.launch({
		args: ['.', `--user-data-dir=${directory}`],
		env: { ...env, COMMANDER_TEST_HOST: '1' },
	})
	page = await app.firstWindow()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
		timeout: 20000,
	})
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline namespace')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByRole('button', { name: 'Connect and browse' }).click()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
const cutoff = '2025-01-01T12:00:00.000Z'
async function seed(id: string, timestamp: string, entity = 'empty', scope = 'active') {
	await page.getByRole('button', { name: `${entity} Active`, exact: true }).click()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const composer = page.getByRole('dialog')
	await composer.getByLabel('Message ID', { exact: true }).fill(id)
	for (const [index, [name, value]] of [
		['fixture-enqueued-time', timestamp],
		['fixture-subqueue', scope],
	].entries()) {
		await composer.getByRole('button', { name: 'Add property', exact: true }).click()
		await composer.getByLabel(`Property name ${index + 1}`, { exact: true }).fill(name)
		await composer.getByLabel(`Property value ${index + 1}`, { exact: true }).fill(value)
	}
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
}
async function configureCutoff() {
	const dialog = page.getByRole('dialog')
	await dialog
		.getByRole('checkbox', {
			name: 'Only purge messages older than a selected date and time',
			exact: true,
		})
		.check()
	await dialog.getByLabel('Purge cutoff time zone', { exact: true }).selectOption('utc')
	await dialog.getByLabel('Purge cutoff date and time', { exact: true }).fill('2025-01-01T12:00')
}
async function single() {
	await page.getByRole('button', { name: 'empty Active', exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Purge messages…', exact: true }).click()
	return page.getByRole('dialog')
}
async function confirmSingle() {
	const dialog = page.getByRole('dialog')
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', { name: /I understand these deletions are permanent/ })
		.check()
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.23.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.23.0/${name}.png` })
}
test('cutoff selection validates time, resets confirmation and deletes only older messages across mixed ordering', async () => {
	await seed('old', '2020-01-01T00:00:00.000Z')
	await seed('new', '2030-01-01T00:00:00.000Z')
	await seed('equal', cutoff)
	await seed('old-behind-new', '2024-01-01T00:00:00.000Z')
	const dialog = await single()
	await expect(dialog.getByLabel('Purge cutoff date and time', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', {
			name: 'Only purge messages older than a selected date and time',
			exact: true,
		})
		.check()
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await expect(dialog).toContainText('Choose a valid date and time')
	await configureCutoff()
	await confirmSingle()
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeEnabled()
	await dialog.getByLabel('Purge cutoff date and time', { exact: true }).fill('2025-01-02T12:00')
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await expect(
		dialog.getByRole('checkbox', { name: /I understand these deletions/ }),
	).not.toBeChecked()
	await dialog.getByLabel('Purge cutoff date and time', { exact: true }).fill('2025-01-01T12:00')
	await confirmSingle()
	await screenshot('purge-cutoff-confirmation')
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Purge result' })
	await expect(result).toContainText('2 deletions confirmed')
	await expect(result).toContainText('2 retained by cutoff')
	await expect(result).toContainText(cutoff)
	await screenshot('purge-cutoff-result')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table')).toContainText('equal')
	await expect(page.locator('.message-table')).toContainText('new')
	await expect(page.locator('.message-table')).not.toContainText('old')
})
test('bulk review binds cutoff across targets, clears old approval on edits and shows aggregate retention', async () => {
	await seed('old-queue', '2020-01-01T00:00:00.000Z')
	await seed('new-queue', '2030-01-01T00:00:00.000Z')
	await seed('old-dlq', '2020-01-01T00:00:00.000Z', 'orders', 'dead-letter')
	await seed('new-dlq', '2030-01-01T00:00:00.000Z', 'orders', 'dead-letter')
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk purge…', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Bulk purge messages', exact: true })
	await dialog.getByLabel('Select empty / Messages', { exact: true }).check()
	await dialog.getByLabel('Select orders / Dead-letter', { exact: true }).check()
	await configureCutoff()
	await dialog.getByRole('button', { name: 'Review selected targets', exact: true }).click()
	await expect(dialog).toContainText('Counts above include all ages')
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await dialog.getByRole('checkbox', { name: /I reviewed every selected subqueue/ }).check()
	await dialog.getByRole('button', { name: 'Change selection', exact: true }).click()
	await dialog.getByLabel('Purge cutoff date and time', { exact: true }).fill('2026-01-01T12:00')
	await dialog.getByRole('button', { name: 'Review selected targets', exact: true }).click()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await expect(
		dialog.getByRole('checkbox', { name: /I reviewed every selected subqueue/ }),
	).not.toBeChecked()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await dialog.getByRole('checkbox', { name: /I reviewed every selected subqueue/ }).check()
	await expect(
		dialog.getByRole('button', { name: 'Start bulk purge', exact: true }),
	).toBeEnabled()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await screenshot('bulk-purge-cutoff-review')
	await dialog.getByRole('button', { name: 'Start bulk purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Bulk purge result' })
	await expect(result).toContainText('2 deletions confirmed')
	await expect(result).toContainText('2 retained by cutoff')
	await expect(result).toContainText('2/2 targets attempted')
	await expect(result).toContainText('2026-01-01T12:00:00.000Z')
})
test('cancels cutoff scanning with retained newer messages visible in progress and final result', async () => {
	await seed('new', '2030-01-01T00:00:00.000Z')
	await seed('purge-wait-receive', '2020-01-01T00:00:00.000Z')
	const dialog = await single()
	await configureCutoff()
	await confirmSingle()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Purge result' })
	await expect(result).toContainText('1 retained by cutoff')
	await dialog.getByRole('button', { name: 'Cancel purge', exact: true }).click()
	await expect(result).toContainText('cancelled')
	await expect(result).toContainText('0 deletions confirmed')
	await expect(result).toContainText('0 uncertain')
	await screenshot('purge-cutoff-cancelled')
})
test('keeps uncertain completion distinct from messages retained by cutoff', async () => {
	await seed('new', '2030-01-01T00:00:00.000Z')
	await seed('unknown-complete', '2020-01-01T00:00:00.000Z')
	const dialog = await single()
	await configureCutoff()
	await confirmSingle()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Purge result' })
	await expect(result).toContainText('unknown')
	await expect(result).toContainText('1 retained by cutoff')
	await expect(result).toContainText('1 uncertain')
	await expect(result).toContainText('0 deletions confirmed')
})
