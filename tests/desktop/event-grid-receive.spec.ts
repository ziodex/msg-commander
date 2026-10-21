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
	directory = await mkdtemp(join(tmpdir(), 'commander-eg-receive-'))
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
const dialog = () => page.getByRole('dialog', { name: 'Receive Event Grid events', exact: true })
async function connect(tenant = 'fixture') {
	await page.getByLabel('Event Grid namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByLabel('Event Grid management tenant', { exact: true }).fill(tenant)
	await page.getByRole('button', { name: 'Connect Event Grid', exact: true }).click()
	await expect(page.getByText('Event Grid connected', { exact: true })).toBeVisible()
}
async function open() {
	await expect(
		page.getByRole('treeitem', { name: 'Event Grid topic orders', exact: true }),
	).toBeVisible()
	const expand = page.getByRole('button', { name: 'Expand Event Grid topic orders', exact: true })
	if (await expand.count()) await expand.click()
	await page
		.getByRole('treeitem', {
			name: 'Event Grid subscription fulfillment under orders',
			exact: true,
		})
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Receive events…', exact: true }).click()
	await expect(dialog()).toBeVisible()
	await expect(
		dialog().getByRole('button', { name: 'Refresh received events', exact: true }),
	).toBeEnabled()
}
async function receive(count = 3) {
	await dialog().getByLabel('Maximum events', { exact: true }).fill(String(count))
	await dialog().getByLabel('Events per request', { exact: true }).fill('2')
	await dialog()
		.getByRole('checkbox', {
			name: 'I understand receiving locks events from this subscription.',
			exact: true,
		})
		.check()
	await dialog().getByRole('button', { name: 'Receive events', exact: true }).click()
}
async function apply(action: string, all = false, event = 'event-1') {
	if (all)
		await dialog()
			.getByRole('checkbox', { name: 'Select all held events', exact: true })
			.check()
	else
		await dialog()
			.getByRole('checkbox', { name: `Select event ${event}`, exact: true })
			.check()
	await dialog().getByLabel('Settlement action', { exact: true }).selectOption(action)
	await dialog()
		.getByRole('checkbox', {
			name: 'I confirm this settlement action for the selected events.',
			exact: true,
		})
		.check()
	await dialog().getByRole('button', { name: 'Apply settlement', exact: true }).click()
}
const receipt = () => dialog().getByRole('region', { name: 'Event Grid pull receipt', exact: true })
test('receives from a tree context menu and inspects colored precise JSON before acknowledging one event', async () => {
	await connect()
	await open()
	await receive()
	await expect(receipt()).toContainText('3/3 events retained')
	await expect(dialog().getByRole('table')).toContainText('event-3')
	await dialog().getByRole('button', { name: 'Inspect event event-1', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Event Grid event inspection', exact: true })
	await expect(inspector.locator('.json-number')).toContainText(['9007199254740993'])
	await expect(inspector.locator('.json-key').first()).toContainText('specversion')
	await expect(inspector).not.toContainText('SECRET-LOCK')
	await mkdir('artifacts/validation-0.44.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.44.0/event-inspection-light.png' })
	await inspector
		.getByRole('button', { name: 'Select this event for settlement', exact: true })
		.click()
	await dialog()
		.getByRole('checkbox', {
			name: 'I confirm this settlement action for the selected events.',
			exact: true,
		})
		.check()
	await dialog().getByRole('button', { name: 'Apply settlement', exact: true }).click()
	await expect(receipt()).toContainText('acknowledge: 1/1 confirmed')
	await expect(dialog().getByRole('table')).toContainText('acknowledged')
	await dialog().getByRole('button', { name: 'Close receiver', exact: true }).click()
	await open()
	await expect(dialog().getByRole('table')).toContainText('acknowledged')
	await dialog().getByRole('button', { name: 'Clear finished snapshots', exact: true }).click()
	await expect(dialog().getByRole('table')).not.toContainText('event-1')
	await expect(dialog().getByRole('table')).toContainText('event-2')
})
test('renews a held event, releases with delay and rejects with checkbox confirmation', async () => {
	await connect()
	await open()
	await receive()
	await expect(receipt()).toContainText('3/3 events retained')
	await apply('renewLock')
	await expect(receipt()).toContainText('renewLock: 1/1 confirmed')
	await dialog().getByRole('checkbox', { name: 'Select event event-1', exact: true }).check()
	await dialog().getByLabel('Settlement action', { exact: true }).selectOption('release')
	await dialog().getByLabel('Release delay', { exact: true }).selectOption('60')
	await dialog()
		.getByRole('checkbox', {
			name: 'I confirm this settlement action for the selected events.',
			exact: true,
		})
		.check()
	await dialog().getByRole('button', { name: 'Apply settlement', exact: true }).click()
	await expect(receipt()).toContainText('release: 1/1 confirmed')
	await apply('reject', false, 'event-2')
	await expect(receipt()).toContainText('reject: 1/1 confirmed')
	await expect(dialog()).toContainText('otherwise it drops them')
	await expect(dialog().getByRole('table')).toContainText('released')
	await expect(dialog().getByRole('table')).toContainText('rejected')
	await expect(dialog().getByRole('textbox')).toHaveCount(0)
})
test('reports per-event partial settlement and prevents reuse of lost locks', async () => {
	await connect('settle-partial')
	await open()
	await receive()
	await expect(receipt()).toContainText('3/3 events retained')
	await apply('acknowledge', true)
	await expect(receipt()).toContainText('2/3 confirmed, 1 failed, 0 uncertain')
	await expect(receipt()).toContainText('TokenLost')
	await expect(
		dialog().getByRole('checkbox', { name: 'Select event event-1', exact: true }),
	).toBeDisabled()
	await expect(dialog()).not.toContainText('SECRET broker')
})
test('keeps cancellation and progress visible in a small dark window with the log hidden', async () => {
	await connect('pull-slow')
	await hideOperations(page)
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await open()
	await app.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].setSize(900, 700)
	})
	await receive()
	await expect(
		dialog().getByRole('button', { name: 'Cancel pull operation', exact: true }),
	).toBeVisible()
	await expect(dialog().getByRole('status')).toContainText('receiving')
	await mkdir('artifacts/validation-0.44.0', { recursive: true })
	await expect(dialog()).toHaveCSS('opacity', '1')
	await page.screenshot({
		path: 'artifacts/validation-0.44.0/receive-progress-dark.png',
		animations: 'disabled',
	})
	await dialog().getByRole('button', { name: 'Cancel pull operation', exact: true }).click()
	await expect(receipt()).toContainText('receive · unknown')
	await expect(receipt()).toContainText('possible additional locks')
	await dialog()
		.getByRole('checkbox', {
			name: 'I understand receiving locks events from this subscription.',
			exact: true,
		})
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Receive events', exact: true }),
	).toBeDisabled()
	await receipt().getByRole('button', { name: 'Recover pull receipt', exact: true }).click()
	await expect(receipt()).toContainText('receive · unknown')
	await receipt().getByRole('checkbox').check()
	await expect(
		dialog().getByRole('button', { name: 'Receive events', exact: true }),
	).toBeEnabled()
})
test('enforces a bounded receive time limit and displays a retained unknown receipt', async () => {
	await connect('pull-slow')
	await open()
	await dialog().getByLabel('Receive time limit (seconds)', { exact: true }).fill('1')
	await receive()
	await expect(receipt()).toContainText('receive · unknown')
	await expect(
		dialog().getByRole('button', { name: 'Close receiver', exact: true }),
	).toBeEnabled()
})
test('retains unknown settlement status and allows inspection while further writes require review', async () => {
	await connect('settle-lost')
	await open()
	await receive()
	await expect(receipt()).toContainText('3/3 events retained')
	await apply('acknowledge', true)
	await expect(receipt()).toContainText('0/3 confirmed, 0 failed, 3 uncertain')
	await expect(dialog().getByRole('table')).toContainText('unknown')
	await dialog().getByRole('button', { name: 'Inspect event event-1', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Event Grid event inspection', exact: true })
	await expect(
		inspector.getByRole('button', { name: 'Select this event for settlement', exact: true }),
	).toBeDisabled()
	await inspector.getByRole('button', { name: 'Close event inspection', exact: true }).click()
	await receipt().getByRole('button', { name: 'Recover pull receipt', exact: true }).click()
	await expect(receipt()).toContainText('acknowledge · unknown')
})
test('bounds large event previews and retains the full event for settlement', async () => {
	await connect('pull-large')
	await open()
	await receive(1)
	await expect(receipt()).toContainText('1/1 events retained')
	await dialog().getByRole('button', { name: 'Inspect event event-1', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Event Grid event inspection', exact: true })
	await expect(inspector).toContainText('Preview truncated at 65,536 characters')
	await inspector.getByRole('button', { name: 'Close event inspection', exact: true }).click()
	await apply('acknowledge')
	await expect(receipt()).toContainText('acknowledge: 1/1 confirmed')
})
test('returns an empty bounded receive and disables Push subscriptions in the context menu', async () => {
	await connect('pull-empty')
	await open()
	await receive()
	await expect(receipt()).toContainText('Azure returned no events')
	await dialog().getByRole('button', { name: 'Close receiver', exact: true }).click()
	await page
		.getByRole('treeitem', { name: 'Event Grid subscription audit under orders', exact: true })
		.click({ button: 'right' })
	await expect(
		page.getByRole('menuitem', { name: 'Receive events…', exact: true }),
	).toHaveAttribute('data-disabled', '')
})
test('shows renewed data sign-in inside the receiver and cancels before a receive POST', async () => {
	await connect('publish-renew')
	await open()
	await receive()
	await expect(dialog()).toContainText('OFFLINE-GRID-PUBLISH')
	await dialog().getByRole('button', { name: 'Cancel pull operation', exact: true }).click()
	await expect(receipt()).toContainText('receive · cancelled')
	await expect(receipt()).toContainText('0 possible additional locks')
})
