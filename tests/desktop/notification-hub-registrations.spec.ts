import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-nh-reg-'))
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
const apply = () => page.getByRole('button', { name: 'Apply query / refresh', exact: true }).click()
test('requires explicit policy selection and supports management tree entry', async () => {
	await profile()
	await page
		.getByLabel('Notification Hubs namespace resource ID', { exact: true })
		.fill(resourceId)
	await page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }).click()
	await expect(page.getByText('Notification Hubs connected', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: 'Notification Hub alerts', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Browse registrations…', exact: true }).click()
	await expect(page.getByLabel('Registration hub name', { exact: true })).toHaveValue('alerts')
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('select a Manage policy')
	await page.getByRole('button', { name: 'Load access policies', exact: true }).click()
	await expect(page.getByLabel('Registration Manage policy', { exact: true })).toHaveValue('')
	await expect(page.locator('option[value="sender"]')).toHaveAttribute('disabled', '')
	await page
		.getByLabel('Registration Manage policy', { exact: true })
		.selectOption('RootManageSharedAccessKey')
	await page.getByLabel('Registration key slot', { exact: true }).selectOption('SecondaryKey')
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(row('apple-native')).toBeVisible()
	await expect(page.locator('body')).not.toContainText('OFFLINE-NH-SECONDARY')
	await page.getByRole('button', { name: 'Back to administration', exact: true }).click()
	await page
		.getByRole('button', { name: 'Notification Hub archive', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Browse registrations…', exact: true }).click()
	await expect(page.getByLabel('Registration hub name', { exact: true })).toHaveValue('archive')
	await expect(row('apple-native')).toBeHidden()
	await page.getByRole('button', { name: 'Load access policies', exact: true }).click()
	await page
		.getByLabel('Registration Manage policy', { exact: true })
		.selectOption('RootManageSharedAccessKey')
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(page.getByText('Registrations connected · archive', { exact: true })).toBeVisible()
	await expect(row('apple-native')).toBeVisible()
	await page.getByRole('button', { name: 'Back to administration', exact: true }).click()
	await page.getByRole('button', { name: 'Disconnect Notification Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'Browse registrations…', exact: true }).click()
	await expect(row('apple-native')).toBeHidden()
	await expect(
		page.getByRole('button', { name: 'Connect registrations', exact: true }),
	).toBeDisabled()
})
test('pages forward and back, applies exact tags and separates staged filters from displayed results', async () => {
	await browse()
	await expect(
		page.getByText('Page 1 · 2 registrations on this page · more available', { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Next registrations page', exact: true }).click()
	await expect(row('windows-native')).toBeVisible()
	await expect(row('apple-native')).toBeHidden()
	await page.getByRole('button', { name: 'Previous registrations page', exact: true }).click()
	await expect(row('apple-native')).toBeVisible()
	await page.getByLabel('Registration query', { exact: true }).selectOption('tag')
	await page.getByLabel('Registration tag', { exact: true }).fill('news')
	await expect(
		page.getByRole('button', { name: 'Next registrations page', exact: true }),
	).toBeDisabled()
	await expect(row('apple-native')).toBeVisible()
	await apply()
	await expect(row('fcm-template')).toBeVisible()
	await expect(row('windows-native')).toBeVisible()
	await expect(row('apple-native')).toBeHidden()
	await expect(
		page.getByRole('button', { name: 'Next registrations page', exact: true }),
	).toBeDisabled()
	await page.getByLabel('Registration tag', { exact: true }).fill('empty')
	await apply()
	await expect(page.getByText(/No registrations on this page/)).toBeVisible()
})
test('inspects templates in a modal with colored JSON and full original XML, including unknown registration types', async () => {
	await browse()
	await mkdir('artifacts/validation-0.35.0', { recursive: true })
	await page.screenshot({
		path: 'artifacts/validation-0.35.0/notification-hub-registrations.png',
	})
	await row('fcm-template').getByRole('button', { name: 'Inspect', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog.getByRole('heading', { name: 'Registration inspection' })).toBeVisible()
	await expect(dialog.locator('.json-key').first()).toContainText('message')
	await expect(dialog.locator('.json-boolean')).toHaveText('true')
	await expect(dialog.getByText("fcm-token-'quoted'&value=one", { exact: true })).toBeVisible()
	await dialog.getByText('Original registration XML (all fields)', { exact: true }).click()
	await expect(dialog.locator('pre.nh-registration-xml')).toContainText('FutureProperty')
	await expect(dialog.locator('script')).toHaveCount(0)
	await page.screenshot({
		path: 'artifacts/validation-0.35.0/notification-hub-registration-inspector.png',
	})
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await expect
		.poll(() =>
			dialog
				.getByRole('button', { name: 'Close registration inspection', exact: true })
				.evaluate((el) => getComputedStyle(el).color),
		)
		.toBe('rgb(238, 233, 224)')
	await page.screenshot({
		path: 'artifacts/validation-0.35.0/notification-hub-registration-dark.png',
	})
	await dialog.getByRole('button', { name: 'Close registration inspection', exact: true }).click()
	await expect(
		row('fcm-template').getByRole('button', { name: 'Inspect', exact: true }),
	).toBeFocused()
	await page.getByRole('button', { name: 'Next registrations page', exact: true }).click()
	await page.getByRole('button', { name: 'Next registrations page', exact: true }).click()
	await row('future-native').getByRole('button', { name: 'Inspect', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('Unknown registration type')
})
test('queries safely encoded PNS handles and validates APNS and WNS formats', async () => {
	await browse(true)
	await page.getByLabel('Registration query', { exact: true }).selectOption('handle')
	await page.getByLabel('Device handle', { exact: true }).fill("fcm-token-'quoted'&value=one")
	await apply()
	await expect(row('fcm-template')).toBeVisible()
	await expect(row('apple-native')).toBeHidden()
	await page.getByLabel('Registration handle format', { exact: true }).selectOption('apns')
	await page.getByLabel('Device handle', { exact: true }).fill('bad-token')
	await apply()
	await expect(page.getByRole('alert')).toContainText('APNS hex token')
	await expect(row('fcm-template')).toBeVisible()
	await page.getByLabel('Device handle', { exact: true }).fill('a'.repeat(64))
	await apply()
	await expect(row('apple-native')).toBeVisible()
	await page.getByLabel('Registration handle format', { exact: true }).selectOption('wns')
	await page
		.getByLabel('Device handle', { exact: true })
		.fill('https://push.example.invalid/channel?a=1&b=2')
	await apply()
	await expect(row('windows-native')).toBeVisible()
	await expect(page.getByRole('link', { name: /push.example/ })).toHaveCount(0)
})
test('keeps a successful page after cancellation, denied access or a failed next page and retries explicitly', async () => {
	await browse(true)
	await page.getByLabel('Registration query', { exact: true }).selectOption('tag')
	await page.getByLabel('Registration tag', { exact: true }).fill('flaky')
	await apply()
	await expect(row('apple-native')).toBeVisible()
	await page.getByRole('button', { name: 'Next registrations page', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('Nothing was retried')
	await expect(row('apple-native')).toBeVisible()
	await page.getByRole('button', { name: 'Next registrations page', exact: true }).click()
	await expect(row('windows-native')).toBeVisible()
	await page.getByLabel('Registration tag', { exact: true }).fill('slow')
	await apply()
	await expect(
		page.getByRole('button', { name: 'Cancel registration operation', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Cancel registration operation', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('cancelled')
	await expect(row('windows-native')).toBeVisible()
	await page.getByLabel('Registration tag', { exact: true }).fill('denied')
	await apply()
	await expect(page.getByRole('alert')).toContainText('Manage rights')
	await expect(page.locator('body')).not.toContainText('SECRET-REGISTRATION-ERROR')
	await expect(row('windows-native')).toBeVisible()
})
test('enforces saved hub-scoped SAS credentials and retains data until explicit disconnect', async () => {
	await profile(true, 'alerts')
	await page.getByRole('button', { name: 'Browse registrations…', exact: true }).click()
	await page.getByLabel('Registration hub name', { exact: true }).fill('archive')
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText(
		'matching the profile namespace and selected hub',
	)
	await page.getByLabel('Registration hub name', { exact: true }).fill('alerts')
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(row('apple-native')).toBeVisible()
	await page.getByRole('button', { name: 'Back to administration', exact: true }).click()
	await page.getByRole('button', { name: 'Browse registrations…', exact: true }).click()
	await expect(row('apple-native')).toBeVisible()
	await page.getByRole('button', { name: 'Disconnect registrations', exact: true }).click()
	await expect(row('apple-native')).toBeHidden()
})
