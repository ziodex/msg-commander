import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-nh-reg-management-'))
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
	await page.getByRole('button', { name: 'Notification Hubs', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function profile(sas = false, entity = '') {
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline registrations')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	if (sas) {
		await page.getByRole('radio', { name: 'Connection string', exact: true }).check()
		await page
			.getByLabel('Namespace connection string', { exact: true })
			.fill(
				`Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;${entity ? `EntityPath=${entity};` : ''}`,
			)
	} else {
		await page.getByLabel('Directory (tenant) ID', { exact: true }).fill('fixture')
		await page
			.getByLabel('Application (client) ID', { exact: true })
			.fill('22222222-2222-4222-8222-222222222222')
	}
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
}
async function browse(sas = false, hub = 'alerts') {
	await profile(sas)
	if (!sas) {
		await page
			.getByLabel('Notification Hubs namespace resource ID', { exact: true })
			.fill(resourceId)
		await page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }).click()
		await expect(page.getByText('Notification Hubs connected', { exact: true })).toBeVisible()
		await page
			.getByRole('button', { name: `Notification Hub ${hub}`, exact: true })
			.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Browse registrations…', exact: true }).click()
		await page.getByRole('button', { name: 'Load access policies', exact: true }).click()
		await page
			.getByLabel('Registration Manage policy', { exact: true })
			.selectOption('RootManageSharedAccessKey')
	} else {
		await page.getByRole('button', { name: 'Browse registrations…', exact: true }).click()
		await page.getByLabel('Registration hub name', { exact: true }).fill(hub)
	}
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(
		page.getByRole('row', { name: 'Registration apple-native', exact: true }),
	).toBeVisible()
}

const row = (name: string) => page.getByRole('row', { name: `Registration ${name}`, exact: true })
const dialog = () => page.getByRole('dialog', { name: 'Registration files', exact: true })
const close = () =>
	dialog().getByRole('button', { name: 'Close registration files', exact: true }).click()
const ack = () =>
	dialog().getByRole('checkbox', {
		name: 'I reviewed the destination and selected registrations, and understand new copies may duplicate existing device handles.',
		exact: true,
	})
async function choose(file = resolve('tests/fixtures/notification-hubs/registrations.xml')) {
	await app.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
	}, file)
	await dialog().getByRole('button', { name: 'Choose registration file…', exact: true }).click()
}
async function save(file: string) {
	await app.evaluate(({ dialog }, file) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
	}, file)
	await dialog().getByRole('button', { name: 'Save registration file…', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('Saved')
}
async function openImport() {
	await page.getByRole('button', { name: 'Import registrations…', exact: true }).click()
	await choose()
}
async function apply() {
	await ack().check()
	await dialog()
		.getByRole('button', { name: 'Create selected registration copies', exact: true })
		.click()
}
test('exports selected snapshots and the current page through native pickers in both formats', async () => {
	await browse(true)
	await expect(
		page.getByRole('button', { name: 'Export selected registrations…', exact: true }),
	).toBeDisabled()
	await row('fcm-template').getByRole('checkbox').check()
	await page.getByRole('button', { name: 'Export selected registrations…', exact: true }).click()
	const json = join(directory, 'selected.json')
	await save(json)
	const parsed = JSON.parse(await readFile(json, 'utf8'))
	expect(parsed.registrations).toHaveLength(1)
	expect(parsed.registrations[0].registrationId).toBe('fcm-template')
	expect(parsed.registrations[0].rawXml).toContain('BodyTemplate')
	expect(JSON.stringify(parsed)).not.toContain('OFFLINE-NH-KEY')
	await close()
	await page.getByRole('button', { name: 'Export current page…', exact: true }).click()
	await dialog().getByLabel('Registration file format', { exact: true }).selectOption('xml')
	const xml = join(directory, 'page.xml')
	await save(xml)
	expect(await readFile(xml, 'utf8')).toContain('apple-native')
	expect(await readFile(xml, 'utf8')).toContain('fcm-template')
})
test('exports a single inspected registration without stacking dialogs', async () => {
	await browse(true)
	await row('apple-native').getByRole('button', { name: 'Inspect', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Export registration…', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(1)
	const file = join(directory, 'inspection.json')
	await save(file)
	expect(JSON.parse(await readFile(file, 'utf8')).registrations).toHaveLength(1)
})
test('previews XML, preserves tags/templates, blocks future types and retains new IDs after reopening results', async () => {
	await browse(true)
	await openImport()
	await expect(
		dialog().getByRole('checkbox', { name: 'Import registration 1', exact: true }),
	).toBeChecked()
	await expect(
		dialog().getByRole('checkbox', { name: 'Import registration 3', exact: true }),
	).toBeDisabled()
	await expect(
		dialog().getByRole('button', { name: 'Create selected registration copies', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('button', { name: 'Review XML 2', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Imported registration XML', exact: true }),
	).toContainText('$(message)')
	await ack().check()
	await dialog().getByRole('checkbox', { name: 'Import registration 1', exact: true }).uncheck()
	await expect(ack()).not.toBeChecked()
	await dialog().getByRole('checkbox', { name: 'Import registration 1', exact: true }).check()
	await mkdir('artifacts/validation-0.40.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.40.0/registration-import-preview.png' })
	await apply()
	await expect(dialog().getByRole('status')).toContainText('2/2 registrations confirmed')
	await expect(dialog()).toContainText('created-1')
	await expect(dialog()).toContainText('created-2')
	await close()
	await page.getByRole('button', { name: 'Registration import results…', exact: true }).click()
	await expect(dialog()).toContainText('2/2 registrations confirmed')
	await dialog()
		.getByRole('button', { name: 'Check retained registration import receipt', exact: true })
		.click()
	await close()
	await page.getByLabel('Registration query', { exact: true }).selectOption('tag')
	await page.getByLabel('Registration tag', { exact: true }).fill('copy:tag')
	await page.getByRole('button', { name: 'Apply query / refresh', exact: true }).click()
	await row('created-2').getByRole('button', { name: 'Inspect', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('sample')
	await expect(page.getByRole('dialog')).toContainText('$(title)')
})
test('imports a Commander JSON archive through an explicitly selected Entra Manage policy', async () => {
	await browse(false)
	await row('fcm-template').getByRole('checkbox').check()
	await page.getByRole('button', { name: 'Export selected registrations…', exact: true }).click()
	const file = join(directory, 'template.json')
	await save(file)
	await close()
	await page.getByRole('button', { name: 'Import registrations…', exact: true }).click()
	await choose(file)
	await apply()
	await expect(dialog().getByRole('status')).toContainText('1/1 registrations confirmed')
})
test('cancels a dispatched import, retains uncertainty and blocks writes until Azure review', async () => {
	await browse(true, 'write-slow')
	await openImport()
	await ack().check()
	await dialog()
		.getByRole('button', { name: 'Create selected registration copies', exact: true })
		.click()
	await expect(
		dialog().getByRole('button', { name: 'Cancel registration file operation', exact: true }),
	).toBeVisible()
	await page.waitForTimeout(150)
	await dialog()
		.getByRole('button', { name: 'Cancel registration file operation', exact: true })
		.click()
	await expect(dialog().getByRole('status')).toContainText('0/2 registrations confirmed')
	await expect(dialog()).toContainText('unknown')
	await close()
	await expect(
		page.getByRole('button', { name: 'Create registration…', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Registration import results…', exact: true }).click()
	await dialog()
		.getByRole('button', { name: 'Check retained registration import receipt', exact: true })
		.click()
	await dialog()
		.getByRole('checkbox', {
			name: 'I checked Azure state and reviewed the uncertain registration import before another write.',
			exact: true,
		})
		.check()
	await close()
	await expect(
		page.getByRole('button', { name: 'Create registration…', exact: true }),
	).toBeEnabled()
})
test('rejects malformed files, discards the old preview and handles picker cancellation', async () => {
	await browse(true)
	await openImport()
	const file = join(directory, 'bad.xml')
	await writeFile(
		file,
		'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///SECRET">]><invalid>&x;</invalid>',
	)
	await choose(file)
	await expect(dialog().getByRole('alert')).toContainText('Invalid registration file')
	expect(await dialog().innerText()).not.toContain('SECRET')
	await expect(
		dialog().getByRole('button', { name: 'Create selected registration copies', exact: true }),
	).toHaveCount(0)
	await app.evaluate(({ dialog }) => {
		dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
	})
	await dialog().getByRole('button', { name: 'Choose registration file…', exact: true }).click()
	await close()
})
test('keeps dark-theme previews and confirmation usable in a small window with inert XML', async () => {
	await browse(true)
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await page.setViewportSize({ width: 1120, height: 760 })
	await openImport()
	await dialog().getByRole('button', { name: 'Review XML 1', exact: true }).click()
	expect(await page.evaluate(() => 'fileExecuted' in window)).toBe(false)
	expect(await dialog().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
		'rgb(44, 42, 38)',
	)
	const box = await dialog().boundingBox()
	expect(box!.y).toBeGreaterThanOrEqual(0)
	expect(box!.y + box!.height).toBeLessThanOrEqual(760)
	await ack().scrollIntoViewIfNeeded()
	await ack().check()
	await expect(
		dialog().getByRole('button', { name: 'Close registration files', exact: true }),
	).toBeInViewport()
	await mkdir('artifacts/validation-0.40.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.40.0/registration-files-dark.png' })
	await close()
})
