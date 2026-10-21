import { hideOperations, showOperations } from './support/operations-log'
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
const dialog = () => page.getByRole('dialog', { name: 'Event Grid inspection', exact: true })
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
async function close() {
	await dialog().getByRole('button', { name: 'Close Event Grid inspection', exact: true }).click()
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
test('creates, edits and deletes namespace topics from the tree with fresh review', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	let modal = editor('Create Event Grid topic')
	await modal.getByLabel('Resource name', { exact: true }).fill('created-topic')
	await modal.getByLabel('Topic retention (days)', { exact: true }).fill('5')
	await expect(
		modal.getByRole('button', { name: 'Create Event Grid topic', exact: true }),
	).toBeDisabled()
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	await expect(modal).toContainText('create confirmed for created-topic')
	await closeEditor(modal)
	await expect(topic('created-topic')).toBeVisible()
	await menu(topic('created-topic'), 'Edit topic')
	modal = editor('Edit Event Grid topic')
	await expect(modal.getByLabel('Topic retention (days)', { exact: true })).toHaveValue('5')
	await modal.getByLabel('Topic retention (days)', { exact: true }).fill('3')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Edit Event Grid topic', exact: true }).click()
	await expect(modal).toContainText('update confirmed')
	await closeEditor(modal)
	await topic('created-topic').locator('.eg-node').click()
	await expect(dialog()).toContainText('Retention (days)')
	await expect(dialog().locator('dd').last()).toHaveText('3')
	await dialog().getByRole('button', { name: 'Delete resource', exact: true }).click()
	modal = editor('Delete Event Grid topic')
	await expect(modal).toContainText('its subscriptions and retained events')
	await modal.getByLabel('Type the exact name to delete', { exact: true }).fill('created-topic')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Delete Event Grid topic', exact: true }).click()
	await expect(modal).toContainText('delete confirmed')
	await closeEditor(modal)
	await expect(topic('created-topic')).toHaveCount(0)
})
test('creates a Queue subscription with event types and all typed filter controls', async () => {
	await connect()
	await expand()
	await menu(topic(), 'Create subscription')
	const modal = editor('Create Event Grid subscription')
	await modal.getByLabel('Resource name', { exact: true }).fill('new-sub')
	await modal.getByRole('checkbox', { name: 'All default event types', exact: true }).uncheck()
	await modal
		.getByLabel('Included event types (one per line)', { exact: true })
		.fill('Order.Paid\nOrder.Shipped')
	await modal.getByRole('button', { name: 'Add advanced filter', exact: true }).click()
	await modal.getByLabel('Filter 1 key', { exact: true }).fill('data.total')
	expect(
		await modal.getByLabel('Filter 1 operator', { exact: true }).locator('option').count(),
	).toBe(19)
	await modal.getByLabel('Filter 1 operator', { exact: true }).selectOption('NumberInRange')
	await modal
		.getByLabel('Filter 1 values', { exact: true })
		.fill('[[9007199254740993,9007199254740995]]')
	await modal.getByText('Review filter JSON', { exact: true }).click()
	await expect(
		modal.locator('.json-number').filter({ hasText: '9007199254740993' }),
	).toBeVisible()
	await acknowledge(modal)
	await mkdir('artifacts/validation-0.42.0', { recursive: true })
	await page.screenshot({
		path: 'artifacts/validation-0.42.0/event-grid-subscription-editor.png',
	})
	await modal.getByRole('button', { name: 'Create Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('create confirmed')
	await closeEditor(modal)
	await expect(sub('new-sub')).toBeVisible()
	await sub('new-sub').click()
	await expect(dialog()).toContainText('Order.Paid')
	await expect(
		dialog().locator('.json-number').filter({ hasText: '9007199254740993' }),
	).toBeVisible()
})
test('edits precise filters and retry settings, resets review on changes, then deletes a subscription', async () => {
	await connect()
	await expand()
	await menu(sub(), 'Edit subscription')
	let modal = editor('Edit Event Grid subscription')
	await expect(modal.getByLabel('Filter 1 values', { exact: true })).toHaveValue(
		'[[9007199254740993,9007199254740995]]',
	)
	await acknowledge(modal)
	await modal.getByLabel('Maximum delivery count', { exact: true }).fill('4')
	await expect(modal.getByRole('checkbox', { name: /I reviewed this/ })).not.toBeChecked()
	await modal.getByLabel('Filter 2 values', { exact: true }).fill('false')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Edit Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('update confirmed')
	await closeEditor(modal)
	await sub().click()
	await expect(dialog()).toContainText('"maxDeliveryCount": 4')
	await expect(dialog()).toContainText('false')
	await dialog().getByRole('button', { name: 'Delete resource', exact: true }).click()
	modal = editor('Delete Event Grid subscription')
	await modal.getByLabel('Type the exact name to delete', { exact: true }).fill('wrong')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Delete Event Grid subscription', exact: true }).click()
	await expect(modal.getByRole('alert')).toContainText('exact resource name')
	await modal.getByLabel('Type the exact name to delete', { exact: true }).fill('fulfillment')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Delete Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('delete confirmed')
	await closeEditor(modal)
	await expect(sub()).toHaveCount(0)
})
test('preserves unknown filters and private Push destinations while editing event types', async () => {
	await connect()
	await expand()
	await menu(sub('audit'), 'Edit subscription')
	const modal = editor('Edit Event Grid subscription')
	await expect(modal).toContainText('Unsupported filters are preserved unchanged')
	await expect(
		modal.getByRole('button', { name: 'Add advanced filter', exact: true }),
	).toHaveCount(0)
	await expect(modal.getByLabel('Delivery mode', { exact: true })).toBeDisabled()
	expect(await modal.innerText()).not.toContain('SECRET')
	await modal.getByRole('checkbox', { name: 'All default event types', exact: true }).uncheck()
	await modal
		.getByLabel('Included event types (one per line)', { exact: true })
		.fill('Order.Paid')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Edit Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('update confirmed')
	await closeEditor(modal)
	await sub('audit').click()
	await expect(dialog()).toContainText('Order.Paid')
	await expect(dialog()).toContainText('FutureOperator')
	await expect(dialog()).toContainText('WebHook')
	expect(await dialog().innerText()).not.toContain('SECRET')
})
test('creates Push webhooks with a write-only URL and rejects invalid typed filters', async () => {
	await connect()
	await expand()
	await menu(topic(), 'Create subscription')
	const modal = editor('Create Event Grid subscription')
	await modal.getByLabel('Resource name', { exact: true }).fill('webhook-sub')
	await modal.getByLabel('Delivery mode', { exact: true }).selectOption('Push')
	await modal
		.getByLabel('HTTPS webhook URL (write-only)', { exact: true })
		.fill('https://example.invalid/?sig=SECRET-CREATE')
	await modal.getByRole('button', { name: 'Add advanced filter', exact: true }).click()
	await modal.getByLabel('Filter 1 operator', { exact: true }).selectOption('BoolEquals')
	await modal.getByLabel('Filter 1 values', { exact: true }).fill('1')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid subscription', exact: true }).click()
	await expect(modal.getByRole('alert')).toContainText('Invalid advanced filter')
	await modal.getByLabel('Filter 1 values', { exact: true }).fill('true')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid subscription', exact: true }).click()
	await expect(modal).toContainText('create confirmed')
	expect(await modal.innerText()).not.toContain('SECRET')
	await closeEditor(modal)
	await sub('webhook-sub').click()
	await expect(dialog()).toContainText('WebHook')
	expect(await dialog().innerText()).not.toContain('SECRET')
})
test('retains unknown receipts, recovers without retry and keeps reads available', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	const modal = editor('Create Event Grid topic')
	await modal.getByLabel('Resource name', { exact: true }).fill('write-lost')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	await expect(modal).toContainText('Azure may have accepted')
	await closeEditor(modal)
	const receipt = page.getByRole('region', { name: 'Event Grid change receipt', exact: true })
	await expect(receipt).toContainText('unknown')
	await showOperations(page)
	await expect(
		page
			.locator('.job-row')
			.filter({ hasText: 'Event Grid: create' })
			.getByText('unknown', { exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Create Event Grid topic', exact: true }),
	).toBeDisabled()
	await receipt.getByRole('button', { name: 'Recover Event Grid receipt', exact: true }).click()
	await expect(receipt).toContainText('unknown')
	await receipt.getByRole('button', { name: 'Inspect changed resource', exact: true }).click()
	await expect(dialog()).toContainText('write-lost')
	await close()
	await receipt.getByRole('checkbox', { name: /I reviewed the receipt/ }).check()
	await expect(
		page.getByRole('button', { name: 'Create Event Grid topic', exact: true }),
	).toBeEnabled()
})
test('shows acceptance and cancellation after dispatch truthfully with the log hidden', async () => {
	await connect()
	await hideOperations(page)
	await page.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	let modal = editor('Create Event Grid topic')
	await modal.getByLabel('Resource name', { exact: true }).fill('write-accepted')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	await expect(modal).toContainText('Azure accepted this change')
	await closeEditor(modal)
	await page.getByRole('checkbox', { name: /I reviewed the receipt/ }).check()
	await page.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	modal = editor('Create Event Grid topic')
	await modal.getByLabel('Resource name', { exact: true }).fill('write-slow')
	await acknowledge(modal)
	await modal.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
	await page.waitForTimeout(250)
	await modal.getByRole('button', { name: 'Cancel Event Grid operation', exact: true }).click()
	await expect(modal).toContainText('Azure may have accepted')
	await expect(modal.getByRole('button', { name: 'Close editor', exact: true })).toBeEnabled()
})
test('keeps modal actions visible in a small dark window', async () => {
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await connect()
	await expand()
	await menu(sub(), 'Edit subscription')
	const modal = editor('Edit Event Grid subscription')
	await expect(modal.getByLabel('Filter 1 values', { exact: true })).toBeVisible()
	const button = modal.getByRole('button', { name: 'Close editor', exact: true }),
		bounds = await button.boundingBox()
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(760)
	await mkdir('artifacts/validation-0.42.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.42.0/event-grid-editor-dark.png' })
})
