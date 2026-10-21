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
	directory = await mkdtemp(join(tmpdir(), 'commander-eg-publish-'))
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
const dialog = () => page.getByRole('dialog', { name: 'Publish CloudEvents', exact: true })
async function connect() {
	await page.getByLabel('Event Grid namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(page.getByText('Event Grid connected', { exact: true })).toBeVisible()
}
async function open(topic = 'orders') {
	if (topic !== 'orders')
		await page.getByRole('button', { name: 'Load more Event Grid topics', exact: true }).click()
	if (topic.startsWith('publish-')) {
		// Create the fixture topic through the real named IPC and tree refresh path.
		await page.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
		const editor = page.getByRole('dialog', { name: 'Create Event Grid topic', exact: true })
		await editor.getByLabel('Resource name', { exact: true }).fill(topic)
		await editor.getByRole('checkbox').check()
		await editor.getByRole('button', { name: 'Create Event Grid topic', exact: true }).click()
		await editor.getByRole('button', { name: 'Close editor', exact: true }).click()
	}
	await page
		.getByRole('treeitem', { name: `Event Grid topic ${topic}`, exact: true })
		.locator('.eg-topic-row')
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Publish CloudEvents…', exact: true }).click()
	await expect(dialog()).toBeVisible()
}
const acknowledge = () =>
	dialog()
		.getByRole('checkbox', {
			name: 'I understand publishing sends events to this topic.',
			exact: true,
		})
		.check()
test('publishes a single CloudEvent with event attributes, typed extensions and precise colored preview', async () => {
	await connect()
	await open()
	await dialog()
		.getByLabel('Event data', { exact: true })
		.fill('{"large":9007199254740993,"ok":true,"text":"<script>alert(1)</script>"}')
	await dialog().getByLabel('Event subject (optional)', { exact: true }).fill('orders/123')
	await dialog().getByRole('button', { name: 'Add extension property', exact: true }).click()
	await dialog().getByLabel('Extension name', { exact: true }).fill('enabled')
	await dialog().getByLabel('Extension type', { exact: true }).selectOption('boolean')
	await dialog().getByLabel('Extension value', { exact: true }).fill('true')
	await dialog().getByRole('button', { name: 'Preview selected event', exact: true }).click()
	await expect(
		dialog().locator('.json-number').filter({ hasText: '9007199254740993' }),
	).toBeVisible()
	expect(await dialog().locator('script').count()).toBe(0)
	await expect(
		dialog().getByRole('button', { name: 'Publish 1 event', exact: true }),
	).toBeDisabled()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'CloudEvents publish receipt', exact: true }),
	).toContainText('1/1 events confirmed')
	await mkdir('artifacts/validation-0.43.0', { recursive: true })
	await dialog().locator('.json-body').scrollIntoViewIfNeeded()
	await page.screenshot({ path: 'artifacts/validation-0.43.0/event-grid-publish-single.png' })
	await dialog().getByRole('button', { name: 'Recover publish receipt', exact: true }).click()
	await expect(dialog()).toContainText('consumer delivery is separate')
})
test('publishes multiple events in bounded batches and invalidates confirmation after editing', async () => {
	await connect()
	await open()
	await dialog().getByLabel('Publishing mode', { exact: true }).selectOption('batch')
	await dialog().getByRole('button', { name: 'Add CloudEvent', exact: true }).click()
	await dialog().getByRole('button', { name: 'Add CloudEvent', exact: true }).click()
	await dialog().getByLabel('Events per request', { exact: true }).fill('2')
	await acknowledge()
	await dialog().getByLabel('Event type', { exact: true }).fill('Order.Updated')
	await expect(
		dialog().getByRole('button', { name: 'Publish 3 events', exact: true }),
	).toBeDisabled()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 3 events', exact: true }).click()
	await expect(dialog()).toContainText('3/3 events confirmed by Event Grid in 2 requests')
	await page.screenshot({ path: 'artifacts/validation-0.43.0/event-grid-publish-batch.png' })
})
test('cancels between batches with visible progress and fixed actions in a small dark window with log hidden', async () => {
	await hideOperations(page)
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await connect()
	await open()
	await dialog().getByLabel('Publishing mode', { exact: true }).selectOption('batch')
	for (let i = 0; i < 3; i++)
		await dialog().getByRole('button', { name: 'Add CloudEvent', exact: true }).click()
	await dialog().getByLabel('Events per request', { exact: true }).fill('1')
	await dialog().getByLabel('Delay between requests (ms)', { exact: true }).fill('1000')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 4 events', exact: true }).click()
	await expect(
		dialog().getByRole('progressbar', { name: 'CloudEvents publishing progress', exact: true }),
	).toBeVisible()
	const bounds = await dialog()
		.getByRole('button', { name: 'Cancel publishing', exact: true })
		.boundingBox()
	expect(bounds!.y + bounds!.height).toBeLessThan(760)
	await page.screenshot({
		path: 'artifacts/validation-0.43.0/event-grid-publish-dark-progress.png',
	})
	await dialog().getByRole('button', { name: 'Cancel publishing', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'CloudEvents publish receipt', exact: true }),
	).toContainText('cancelled')
	await expect(dialog()).toContainText('0 uncertain')
	await dialog().getByRole('button', { name: 'Close publisher', exact: true }).click()
	await expect(
		page.getByRole('treeitem', { name: 'Event Grid topic orders', exact: true }),
	).toBeVisible()
})
test('retains unknown sends, blocks further writes until review and recovers without publishing again', async () => {
	await connect()
	await open('publish-lost')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
	await expect(dialog()).toContainText('may have been accepted')
	await expect(dialog()).toContainText('0 confirmed · 1 uncertain')
	await dialog().getByRole('button', { name: 'Recover publish receipt', exact: true }).click()
	await acknowledge()
	await expect(
		dialog().getByRole('button', { name: 'Publish 1 event', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed the uncertain send and possible duplicates before sending again.',
			exact: true,
		})
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Publish 1 event', exact: true }),
	).toBeEnabled()
	expect(await dialog().innerText()).not.toContain('SECRET')
})
test('validates payloads before sending and supports text and base64 event data', async () => {
	await connect()
	await open()
	await dialog().getByLabel('Event data', { exact: true }).fill('{')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText('valid JSON')
	for (const [mode, value] of [
		['text', 'hello'],
		['base64', 'AAEC'],
	]) {
		await dialog().getByLabel('Event data format', { exact: true }).selectOption(mode)
		await dialog().getByLabel('Event data', { exact: true }).fill(value)
		await acknowledge()
		await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
		await expect(dialog()).toContainText('1/1 events confirmed')
	}
})

test('cancels an in-flight send with an uncertain receipt', async () => {
	await connect()
	await open('publish-slow')
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
	await expect(
		dialog().getByRole('progressbar', { name: 'CloudEvents publishing progress', exact: true }),
	).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel publishing', exact: true }).click()
	await expect(dialog()).toContainText('may have been accepted')
	await expect(dialog()).toContainText('0 confirmed · 1 uncertain')
})
test('shows cancellable renewed data-plane sign-in inside the composer with the log hidden', async () => {
	await hideOperations(page)
	await page.getByLabel('Event Grid management tenant', { exact: true }).fill('publish-renew')
	await connect()
	await open()
	await acknowledge()
	await dialog().getByRole('button', { name: 'Publish 1 event', exact: true }).click()
	await expect(dialog().getByText('OFFLINE-GRID-PUBLISH', { exact: true })).toBeVisible()
	await expect(
		dialog().getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel publishing', exact: true }).click()
	await expect(dialog()).toContainText('0 confirmed · 0 uncertain')
	await expect(
		dialog().getByRole('region', { name: 'CloudEvents publish receipt', exact: true }),
	).toContainText('cancelled')
})
