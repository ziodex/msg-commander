import { hideOperations } from './support/operations-log'
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
test('browses paged topics/subscriptions and inspects precise colored JSON in a modal', async () => {
	await connect()
	await expect(topic('more-orders')).toHaveCount(0)
	await page.getByRole('button', { name: 'Load more Event Grid topics', exact: true }).click()
	await expect(topic('more-orders')).toBeVisible()
	await expand()
	await page
		.getByRole('button', { name: 'Load more subscriptions for orders', exact: true })
		.click()
	await expect(sub('extra')).toBeVisible()
	await mkdir('artifacts/validation-0.42.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.42.0/event-grid-tree.png' })
	await sub().click()
	await expect(dialog()).toContainText('Order.Created')
	await expect(dialog()).toContainText('NumberInRange')
	await expect(
		dialog().locator('.json-number').filter({ hasText: '9007199254740993' }),
	).toBeVisible()
	expect(await dialog().locator('.json-key').count()).toBeGreaterThan(10)
	expect(await dialog().locator('script').count()).toBe(0)
	await expect(
		dialog().getByRole('button', { name: 'Refresh inspection', exact: true }),
	).toBeEnabled()
	await mkdir('artifacts/validation-0.42.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.42.0/event-grid-filters.png' })
	await close()
	await expect(sub()).toBeVisible()
})
test('shows Push omissions, unknown filters and absent/empty event types accurately', async () => {
	await connect()
	await expand()
	await sub('audit').click()
	await expect(dialog()).toContainText('Unknown operator')
	await expect(dialog()).toContainText('Not specified · all default event types.')
	await expect(dialog()).toContainText(
		'Push endpoint URLs, delivery headers and authentication details are omitted.',
	)
	expect(await dialog().innerText()).not.toContain('SECRET')
	await close()
	await page
		.getByRole('button', { name: 'Load more subscriptions for orders', exact: true })
		.click()
	await sub('extra').click()
	await expect(dialog()).toContainText('Azure returned an empty event-type list.')
	await expect(dialog()).toContainText('No advanced filters returned.')
})
test('supports context refresh, keyboard menus, loaded-topic search and expand/collapse', async () => {
	await connect()
	await expand()
	await sub().click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Refresh subscriptions', exact: true }).click()
	await expect(sub()).toBeVisible()
	await sub().focus()
	await page.keyboard.press('Shift+F10')
	await page
		.getByRole('menuitem', { name: 'Inspect subscription and filters', exact: true })
		.click()
	await expect(dialog()).toContainText('Order.Created')
	await close()
	await page.getByRole('button', { name: 'Collapse all topics', exact: true }).click()
	await expect(sub()).toHaveCount(0)
	await page.getByRole('button', { name: 'Expand all topics', exact: true }).click()
	await expect(sub()).toBeVisible()
	await page.getByLabel('Find a loaded topic', { exact: true }).fill('archive')
	await expect(topic()).toHaveCount(0)
	await expect(topic('archive')).toBeVisible()
	await page.getByLabel('Find a loaded topic', { exact: true }).fill('')
	await topic().locator('.eg-topic-row').click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Inspect topic', exact: true }).click()
	await expect(dialog()).toContainText('CloudEventSchemaV1_0')
	await close()
	await page.getByRole('button', { name: 'Inspect namespace', exact: true }).click()
	await expect(dialog()).toContainText('HTTP topics hostname')
})
test('cancels slow modal reads and keeps the resource tree available after denied reads', async () => {
	await connect()
	await page.getByRole('button', { name: 'Load more Event Grid topics', exact: true }).click()
	await topic('denied').locator('.eg-node').click()
	await expect(dialog().getByRole('alert')).toContainText('read permission')
	expect(await dialog().innerText()).not.toContain('SECRET')
	await close()
	await topic('slow').locator('.eg-node').click()
	await dialog().getByRole('button', { name: 'Cancel Event Grid operation', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText(/cancel/i)
	await close()
	await expect(topic()).toBeVisible()
	await page.getByRole('button', { name: 'Inspect namespace', exact: true }).click()
	await expect(dialog()).toContainText('HTTP topics hostname')
})
test('shows cancellable device sign-in with the log hidden and retries a denied connection', async () => {
	await hideOperations(page)
	await page.getByLabel('Event Grid namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByLabel('Event Grid management tenant', { exact: true }).fill('slow')
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(
		page
			.getByRole('region', { name: 'Event Grid resources', exact: true })
			.getByText('OFFLINE-GRID', { exact: true }),
	).toBeVisible()
	await expect(
		page
			.getByRole('region', { name: 'Event Grid resources', exact: true })
			.getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Cancel Event Grid operation', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Connect Event Grid', exact: true }),
	).toBeEnabled()
	await page.getByLabel('Event Grid management tenant', { exact: true }).fill('denied')
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('read permission')
	await page.getByLabel('Event Grid management tenant', { exact: true }).fill('fixture')
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(topic()).toBeVisible()
})
test('keeps inspection actions visible in small dark windows and renews sign-in inside the modal', async () => {
	await connect()
	await hideOperations(page)
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await expand()
	await sub().click()
	await expect(dialog()).toContainText('NumberInRange')
	const button = await dialog()
		.getByRole('button', { name: 'Close Event Grid inspection', exact: true })
		.boundingBox()
	expect(button!.y + button!.height).toBeLessThan(760)
	await expect
		.poll(() => dialog().evaluate((el) => getComputedStyle(el).backgroundColor))
		.toBe('rgb(44, 42, 38)')
	await expect(
		dialog().getByRole('button', { name: 'Refresh inspection', exact: true }),
	).toBeEnabled()
	await mkdir('artifacts/validation-0.42.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.42.0/event-grid-dark.png' })
	await close()
	await page.getByRole('button', { name: 'Load more Event Grid topics', exact: true }).click()
	await topic('renew').locator('.eg-node').click()
	await expect(dialog().getByText('OFFLINE-GRID-RENEW', { exact: true })).toBeVisible()
	await expect(
		dialog().getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel Event Grid operation', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText(/cancel/i)
})
test('clears discovered resources when connection settings change', async () => {
	await connect()
	await expand()
	await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Edited Event Grid')
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Connect Event Grid', exact: true }),
	).toBeVisible()
	await expect(topic()).toHaveCount(0)
})
