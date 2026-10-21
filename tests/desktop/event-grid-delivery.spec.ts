import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-eg-'))
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
	await page.getByRole('button', { name: 'Event Grid', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline Event Grid')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.westeurope-1.eventgrid.azure.net')
	await expect(page.getByRole('radio', { name: 'Connection string', exact: true })).toHaveCount(0)
	await page.getByLabel('Directory (tenant) ID', { exact: true }).fill('fixture')
	await page
		.getByLabel('Application (client) ID', { exact: true })
		.fill('22222222-2222-4222-8222-222222222222')
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
const topic = (name = 'orders') =>
	page.getByRole('treeitem', { name: `Event Grid topic ${name}`, exact: true })
const sub = (name = 'fulfillment') =>
	page.getByRole('treeitem', {
		name: `Event Grid subscription ${name} under orders`,
		exact: true,
	})
async function connect() {
	await page.getByLabel('Event Grid namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(page.getByText('Event Grid connected', { exact: true })).toBeVisible()
	await expect(topic()).toBeVisible()
}
async function expand() {
	await page.getByRole('button', { name: 'Expand Event Grid topic orders', exact: true }).click()
	await expect(sub()).toBeVisible()
}
const editor = (name: string) => page.getByRole('dialog', { name, exact: true })
async function menu(target: ReturnType<typeof topic>, action: string) {
	const row = target.locator('.eg-topic-row')
	await ((await row.count()) ? row : target).click({ button: 'right' })
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function acknowledge(modal: ReturnType<typeof editor>) {
	await modal.getByRole('checkbox', { name: /I reviewed this/ }).check()
}
async function closeEditor(modal: ReturnType<typeof editor>) {
	await modal.getByRole('button', { name: 'Close editor', exact: true }).click()
}
const prefix =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/'
const identityId = prefix + 'Microsoft.ManagedIdentity/userAssignedIdentities/fixture-identity'
const hubId = prefix + 'Microsoft.EventHub/namespaces/fixture/eventhubs/orders'
const storageId = prefix + 'Microsoft.Storage/storageAccounts/fixturestore'
async function editSub(name = 'audit') {
	await menu(sub(name), 'Edit subscription')
	const modal = editor('Edit Event Grid subscription')
	await expect(modal.getByLabel('Dead-letter destination', { exact: true })).toBeVisible()
	return modal
}
async function save(modal: ReturnType<typeof editor>) {
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Edit Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('update confirmed')
}
async function deadLetter(modal: ReturnType<typeof editor>) {
	await modal.getByLabel('Dead-letter destination', { exact: true }).selectOption('set')
	await modal.getByLabel('Dead-letter storage account ARM ID', { exact: true }).fill(storageId)
	await modal.getByLabel('Dead-letter blob container', { exact: true }).fill('deadletters')
}
test('edits static and dynamic headers with private values and fresh review', async () => {
	await connect()
	await expand()
	let modal = await editSub()
	await expect(modal).toContainText('Existing header names: Authorization')
	await expect(modal).not.toContainText('SECRET')
	await modal.getByLabel('Custom delivery headers', { exact: true }).selectOption('replace')
	await modal.getByRole('button', { name: 'Add delivery header', exact: true }).click()
	await modal.getByLabel('Delivery header 1 name', { exact: true }).fill('X-App')
	await modal.getByLabel('Delivery header 1 value', { exact: true }).fill('SECRET-HEADER-EDIT')
	await expect(modal.getByLabel('Delivery header 1 value', { exact: true })).toHaveAttribute(
		'type',
		'password',
	)
	await modal.getByRole('button', { name: 'Add delivery header', exact: true }).click()
	await modal.getByLabel('Delivery header 2 name', { exact: true }).fill('X-Route')
	await modal.getByLabel('Delivery header 2 type', { exact: true }).selectOption('Dynamic')
	await modal.getByLabel('Delivery header 2 JSON path', { exact: true }).fill('data.category')
	await acknowledge(modal)
	await modal.getByLabel('Delivery header 2 JSON path', { exact: true }).fill('data.region')
	await expect(modal.getByRole('checkbox', { name: /I reviewed this/ })).not.toBeChecked()
	await mkdir('artifacts/validation-0.46.0', { recursive: true })
	await modal.getByLabel('Custom delivery headers', { exact: true }).scrollIntoViewIfNeeded()
	await page.screenshot({ path: 'artifacts/validation-0.46.0/delivery-light.png' })
	await save(modal)
	await expect(modal.getByLabel('Delivery header 1 value', { exact: true })).toHaveCount(0)
	await expect(modal).not.toContainText('SECRET')
	await closeEditor(modal)
	modal = await editSub()
	await expect(modal).toContainText('X-App (Static, secret), X-Route (Dynamic)')
	await expect(modal.getByLabel('Custom delivery headers', { exact: true })).toHaveValue('keep')
	await expect(modal).not.toContainText('SECRET')
})
test('replaces an existing destination with a managed Event Hub and blob dead-lettering', async () => {
	await connect()
	await expand()
	let modal = await editSub()
	await modal.getByRole('checkbox', { name: 'Replace delivery destination', exact: true }).check()
	await expect(modal.getByLabel('Custom delivery headers', { exact: true })).toHaveValue(
		'replace',
	)
	await expect(modal.getByLabel('Delivery identity', { exact: true })).toHaveValue('None')
	await modal.getByLabel('Push destination type', { exact: true }).selectOption('EventHub')
	await modal.getByLabel('Destination ARM resource ID', { exact: true }).fill(hubId)
	await modal.getByLabel('Delivery identity', { exact: true }).selectOption('UserAssigned')
	await modal
		.getByLabel('Delivery user-assigned identity ARM ID', { exact: true })
		.fill(identityId)
	await deadLetter(modal)
	await save(modal)
	await closeEditor(modal)
	modal = await editSub()
	await expect(modal).toContainText('Current destination: EventHub')
	await expect(modal).toContainText(hubId)
	await expect(modal).toContainText('Identity: UserAssigned')
	await expect(modal).toContainText(identityId)
	await expect(modal).toContainText('Current dead-letter storage:')
	await expect(modal).toContainText('deadletters')
	await expect(modal).toContainText('Existing header names: None')
	await expect(modal).not.toContainText('SECRET')
})
test('configures and explicitly disables dead-lettering for Queue subscriptions', async () => {
	await connect()
	await expand()
	let modal = await editSub('fulfillment')
	await expect(modal.getByLabel('Delivery identity', { exact: true })).toHaveCount(0)
	await deadLetter(modal)
	await modal.getByLabel('Dead-letter identity', { exact: true }).selectOption('UserAssigned')
	await modal
		.getByLabel('Dead-letter user-assigned identity ARM ID', { exact: true })
		.fill(identityId)
	await save(modal)
	await closeEditor(modal)
	modal = await editSub('fulfillment')
	await expect(modal).toContainText('Current dead-letter storage:')
	await modal.getByLabel('Dead-letter destination', { exact: true }).selectOption('clear')
	await expect(modal).toContainText('may be dropped')
	await expect(modal.getByLabel('Type the exact name to delete', { exact: true })).toHaveCount(0)
	await save(modal)
	await closeEditor(modal)
	modal = await editSub('fulfillment')
	await expect(modal).not.toContainText('Current dead-letter storage:')
})
test('supports managed webhook delivery with tenant and token audience', async () => {
	await connect()
	await expand()
	let modal = await editSub()
	await modal.getByRole('checkbox', { name: 'Replace delivery destination', exact: true }).check()
	await modal
		.getByLabel('HTTPS webhook URL (write-only)', { exact: true })
		.fill('https://example.invalid/?sig=SECRET-REPLACEMENT')
	await modal.getByLabel('Delivery identity', { exact: true }).selectOption('SystemAssigned')
	await modal
		.getByLabel('Webhook token tenant ID', { exact: true })
		.fill('22222222-2222-2222-2222-222222222222')
	await modal
		.getByLabel('Webhook token audience (application ID or URI)', { exact: true })
		.fill('api://webhook-app')
	await save(modal)
	await expect(modal).not.toContainText('SECRET')
	await closeEditor(modal)
	modal = await editSub()
	await expect(modal).toContainText('Identity: SystemAssigned')
	await expect(modal.getByLabel('HTTPS webhook URL (write-only)', { exact: true })).toHaveCount(0)
	await expect(modal).not.toContainText('api://webhook-app')
})
test('rejects an identity absent from the namespace and preserves the current destination', async () => {
	await connect()
	await expand()
	let modal = await editSub()
	await modal.getByRole('checkbox', { name: 'Replace delivery destination', exact: true }).check()
	await modal.getByLabel('Push destination type', { exact: true }).selectOption('EventHub')
	await modal.getByLabel('Destination ARM resource ID', { exact: true }).fill(hubId)
	await modal.getByLabel('Delivery identity', { exact: true }).selectOption('UserAssigned')
	await modal
		.getByLabel('Delivery user-assigned identity ARM ID', { exact: true })
		.fill(identityId + '-missing')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Edit Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('not configured on the connected namespace')
	await closeEditor(modal)
	modal = await editSub()
	await expect(modal).toContainText('Current destination: WebHook')
})
test('bounds header rows and keeps actions visible in a small dark window', async () => {
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await connect()
	await expand()
	const modal = await editSub()
	await modal.getByLabel('Custom delivery headers', { exact: true }).selectOption('replace')
	for (let index = 1; index <= 10; index++) {
		await modal.getByRole('button', { name: 'Add delivery header', exact: true }).click()
		await modal
			.getByLabel(`Delivery header ${index} name`, { exact: true })
			.fill('X-App-' + index)
		await modal.getByLabel(`Delivery header ${index} value`, { exact: true }).fill('test')
	}
	await expect(
		modal.getByRole('button', { name: 'Add delivery header', exact: true }),
	).toBeDisabled()
	const button = modal.getByRole('button', { name: 'Close editor', exact: true }),
		bounds = await button.boundingBox()
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(760)
	await mkdir('artifacts/validation-0.46.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.46.0/delivery-dark.png' })
	await save(modal)
})
test('clears write-only delivery fields after an uncertain creation and recovers its receipt', async () => {
	await connect()
	await expand()
	await menu(topic(), 'Create subscription')
	const modal = editor('Create Event Grid subscription')
	await modal.getByLabel('Resource name', { exact: true }).fill('write-lost')
	await modal.getByLabel('Delivery mode', { exact: true }).selectOption('Push')
	await modal
		.getByLabel('HTTPS webhook URL (write-only)', { exact: true })
		.fill('https://example.invalid/?sig=SECRET-LOST')
	await modal.getByLabel('Custom delivery headers', { exact: true }).selectOption('replace')
	await modal.getByRole('button', { name: 'Add delivery header', exact: true }).click()
	await modal.getByLabel('Delivery header 1 name', { exact: true }).fill('Authorization')
	await modal.getByLabel('Delivery header 1 value', { exact: true }).fill('SECRET-BEARER')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('Azure may have accepted')
	await expect(modal.getByLabel('Delivery header 1 value', { exact: true })).toHaveCount(0)
	await expect(modal.getByLabel('HTTPS webhook URL (write-only)', { exact: true })).toHaveCount(0)
	await expect(modal).not.toContainText('SECRET')
	await closeEditor(modal)
	await page.getByRole('button', { name: 'Recover Event Grid receipt', exact: true }).click()
	await expect(
		page.getByRole('region', { name: 'Event Grid change receipt', exact: true }),
	).toBeVisible()
	await expect(page.locator('body')).not.toContainText('SECRET')
})
