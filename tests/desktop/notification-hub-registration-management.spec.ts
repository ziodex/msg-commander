import { test, expect } from '@playwright/test'
import { generateKeyPairSync } from 'node:crypto'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const apply = () => page.getByRole('button', { name: 'Apply query / refresh', exact: true }).click()

const dialog = () => page.getByRole('dialog')
const acknowledge = () => dialog().getByRole('checkbox').check()
async function searchTag(tag: string) {
	await page.getByLabel('Registration query', { exact: true }).selectOption('tag')
	await page.getByLabel('Registration tag', { exact: true }).fill(tag)
	await apply()
}
async function createTemplate(tag = 'created-test') {
	await page.getByRole('button', { name: 'Create registration…', exact: true }).click()
	await dialog()
		.getByLabel('Registration platform', { exact: true })
		.selectOption('FcmV1TemplateRegistrationDescription')
	await dialog()
		.getByLabel('Registration device handle', { exact: true })
		.fill('new-fixture-token')
	await dialog()
		.getByLabel('Registration tags', { exact: true })
		.fill(tag + ', customer:123')
	await dialog().getByLabel('Registration template name', { exact: true }).fill('sample')
	await expect(
		dialog().getByRole('button', { name: 'Create registration now', exact: true }),
	).toBeDisabled()
	await acknowledge()
	await dialog()
		.getByLabel('Registration device handle', { exact: true })
		.fill('reviewed-fixture-token')
	await expect(dialog().getByRole('checkbox')).not.toBeChecked()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Create registration now', exact: true }).click()
}
test('creates, edits and deletes a template with tags from the modal inspector', async () => {
	await browse(true)
	await createTemplate()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
	await expect(dialog()).toContainText('created-1')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await searchTag('created-test')
	await row('created-1').getByRole('button', { name: 'Inspect', exact: true }).click()
	await expect(dialog()).toContainText('sample')
	await dialog().getByRole('button', { name: 'Edit registration…', exact: true }).click()
	await expect(
		dialog().getByRole('heading', { name: 'Edit registration', exact: true }),
	).toBeVisible()
	await expect(dialog().getByLabel('Registration platform', { exact: true })).toBeDisabled()
	await dialog().getByLabel('Registration tags', { exact: true }).fill('edited-test')
	await dialog()
		.getByLabel('Registration template body', { exact: true })
		.fill('{"message":{"notification":{"body":"$(updated)"}}}')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Save registration', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await searchTag('edited-test')
	await row('created-1').getByRole('button', { name: 'Inspect', exact: true }).click()
	await expect(dialog()).toContainText('$(updated)')
	await dialog().getByRole('button', { name: 'Delete registration…', exact: true }).click()
	await expect(dialog().getByRole('textbox')).toHaveCount(0)
	await expect(
		dialog().getByRole('button', { name: 'Delete registration now', exact: true }),
	).toBeDisabled()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Delete registration now', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await expect(page.getByText('No registrations on this page.', { exact: false })).toBeVisible()
})
test('preserves platform extension fields and exposes advanced XML with safe template text', async () => {
	await browse(true)
	await row('fcm-template').getByRole('button', { name: 'Edit', exact: true }).click()
	await expect(dialog().getByLabel('Registration tags', { exact: true })).toHaveValue(
		'news, customer:123',
	)
	await dialog().getByLabel('Registration tags', { exact: true }).fill('preserved')
	await dialog().getByRole('button', { name: 'Advanced registration XML…', exact: true }).click()
	await expect(dialog().getByLabel('Registration description XML', { exact: true })).toHaveValue(
		/FutureProperty/,
	)
	await acknowledge()
	await dialog().getByRole('button', { name: 'Save registration', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await searchTag('preserved')
	await row('fcm-template').getByRole('button', { name: 'Inspect', exact: true }).click()
	await dialog().getByText('Original registration XML (all fields)', { exact: true }).click()
	await expect(dialog().locator('pre.nh-registration-xml')).toContainText('FutureProperty')
	await expect(dialog().locator('script')).toHaveCount(0)
	await mkdir('artifacts/validation-0.36.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.36.0/registration-inspection-light.png' })
	await dialog()
		.getByRole('button', { name: 'Close registration inspection', exact: true })
		.click()
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await row('fcm-template').getByRole('button', { name: 'Edit', exact: true }).click()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	const bounds = await dialog().boundingBox(),
		save = await dialog()
			.getByRole('button', { name: 'Save registration', exact: true })
			.boundingBox()
	expect(bounds && save && save.y + save.height <= bounds.y + bounds.height - 12).toBe(true)
	await page.screenshot({ path: 'artifacts/validation-0.36.0/registration-editor-dark.png' })
})
test('rejects a stale delete and requires an explicit current-state reload', async () => {
	await browse(true, 'conflict')
	await row('apple-native').getByRole('button', { name: 'Delete', exact: true }).click()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Delete registration now', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('ETag conflict')
	await expect(
		dialog().getByRole('button', { name: 'Delete registration now', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('button', { name: 'Reload current registration', exact: true }).click()
	await expect(dialog()).toContainText('43')
	await expect(dialog().getByRole('checkbox')).not.toBeChecked()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Delete registration now', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
})
test('retains and recovers uncertain create outcomes and blocks further writes until reviewed', async () => {
	await browse(true, 'uncertain')
	await createTemplate('unique-uncertain')
	await expect(dialog().getByRole('status')).toContainText('unknown')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Create registration…', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Check registration receipt', exact: true }).click()
	await expect(page.getByLabel('Registration change receipt')).toContainText('unknown')
	await searchTag('unique-uncertain')
	await expect(row('created-1')).toBeVisible()
	await page
		.getByLabel('I checked Azure state and reviewed the uncertain registration outcome.', {
			exact: true,
		})
		.check()
	await expect(
		page.getByRole('button', { name: 'Create registration…', exact: true }),
	).toBeEnabled()
})
test('cancels dispatched registration writes without claiming rollback', async () => {
	await browse(true, 'write-slow')
	await page.getByRole('button', { name: 'Create registration…', exact: true }).click()
	await dialog().getByLabel('Registration device handle', { exact: true }).fill('fixture-token')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Create registration now', exact: true }).click()
	await dialog()
		.getByRole('button', { name: 'Cancel registration operation', exact: true })
		.click()
	await expect(dialog().getByRole('status')).toContainText('unknown')
	await expect(dialog()).toContainText('Nothing was retried')
})
test('refuses mutation without an ETag and validates XML and tags before sending', async () => {
	await browse(true, 'no-etag')
	await row('apple-native').getByRole('button', { name: 'Delete', exact: true }).click()
	await expect(dialog()).toContainText('Missing — reload required')
	await acknowledge()
	await expect(
		dialog().getByRole('button', { name: 'Delete registration now', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await page.getByRole('button', { name: 'Create registration…', exact: true }).click()
	await dialog().getByLabel('Registration device handle', { exact: true }).fill('fixture-token')
	await dialog().getByLabel('Registration tags', { exact: true }).fill('bad tag')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Create registration now', exact: true }).click()
	await expect(dialog().getByRole('alert')).toBeVisible()
	await dialog().getByLabel('Registration tags', { exact: true }).fill('valid')
	await dialog().getByRole('button', { name: 'Advanced registration XML…', exact: true }).click()
	await dialog().getByLabel('Registration description XML', { exact: true }).fill('<invalid>')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Create registration now', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText('valid registration description XML')
	await expect(page.getByLabel('Registration change receipt')).toHaveCount(0)
})
test('creates Browser subscriptions with validated endpoint, P256DH and Auth fields', async () => {
	await browse(true)
	await page.getByRole('button', { name: 'Create registration…', exact: true }).click()
	await dialog()
		.getByLabel('Registration platform', { exact: true })
		.selectOption('BrowserRegistrationDescription')
	const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
		format: 'jwk',
	})
	const pub = Buffer.concat([
		Buffer.from([4]),
		Buffer.from(key.x!, 'base64url'),
		Buffer.from(key.y!, 'base64url'),
	]).toString('base64url')
	await dialog()
		.getByLabel('Registration device handle', { exact: true })
		.fill('https://push.example.invalid/subscription')
	await dialog().getByLabel('Browser P256DH key', { exact: true }).fill(pub)
	await dialog()
		.getByLabel('Browser Auth secret', { exact: true })
		.fill(Buffer.alloc(16, 1).toString('base64url'))
	await dialog().getByLabel('Registration tags', { exact: true }).fill('browser-created')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Create registration now', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('confirmed')
	await dialog().getByRole('button', { name: 'Close registration editor', exact: true }).click()
	await searchTag('browser-created')
	await expect(row('created-1')).toContainText('Browser')
})
