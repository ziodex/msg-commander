import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture is excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-events-'))
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
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline events')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function connect(hub = 'telemetry') {
	await page.getByLabel('Known Event Hub name', { exact: true }).fill(hub)
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await expect(page.getByText('Event Hubs connected', { exact: true })).toBeVisible()
}
async function partition(hub = 'telemetry', id = '0', group = '$Default') {
	await page.getByRole('button', { name: `${hub} ${group} partition ${id}`, exact: true }).click()
	await expect(page.getByLabel('Event read count', { exact: true })).toBeVisible()
}
async function read(count = 3, seconds = 5) {
	if (!(await page.getByLabel('Event read count', { exact: true }).isVisible()))
		await page.locator('.eh-read-settings > summary').click()
	await page.getByLabel('Event read count', { exact: true }).fill(String(count))
	await page.getByLabel('Event read time limit', { exact: true }).fill(String(seconds))
	await page.getByRole('button', { name: 'Read events', exact: true }).click()
}

async function clipboard() {
	return app.evaluate(({ clipboard }) => clipboard.readText())
}
test('copies namespace, hub, group and partition URLs from the tree using both schemes', async () => {
	await connect()
	await page
		.getByRole('button', { name: 'Event Hubs · right-click for actions' })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Copy HTTPS URL', exact: true }).click()
	await expect.poll(clipboard).toBe('https://fixture.servicebus.windows.net')
	await page.getByRole('button', { name: '▾ telemetry', exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Copy Service Bus URL', exact: true }).click()
	await expect.poll(clipboard).toBe('sb://fixture.servicebus.windows.net/telemetry')
	const summary = page.locator('.eh-branch summary').filter({ hasText: /^\$Default$/ })
	await summary.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Copy HTTPS URL', exact: true }).click()
	await expect
		.poll(clipboard)
		.toBe('https://fixture.servicebus.windows.net/telemetry/consumergroups/%24Default')
	const part = page.getByRole('button', { name: 'telemetry $Default partition 0', exact: true })
	await part.focus()
	await part.press('Shift+F10')
	await page.getByRole('menuitem', { name: 'Copy HTTPS URL', exact: true }).click()
	await expect
		.poll(clipboard)
		.toBe(
			'https://fixture.servicebus.windows.net/telemetry/consumergroups/%24Default/partitions/0',
		)
	expect(await clipboard()).not.toMatch(/SharedAccess|not-a-real-secret/)
})
test('opens exact partition statistics, refreshes on a selected interval and copies a row URL', async () => {
	await connect()
	await page.getByRole('button', { name: '▾ telemetry', exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Statistics…', exact: true }).click()
	const dialog = page.getByRole('dialog'),
		table = dialog.getByRole('table', { name: 'Event Hub partition statistics' })
	await expect(table.locator('tbody tr')).toHaveCount(2)
	await expect(table).toContainText('9007199254740993')
	await expect(table).toContainText('Empty')
	await expect(dialog).toContainText('not a queue depth')
	await dialog.getByRole('button', { name: 'Copy partition 1 URL', exact: true }).click()
	await expect
		.poll(clipboard)
		.toBe(
			'https://fixture.servicebus.windows.net/telemetry/consumergroups/%24Default/partitions/1',
		)
	await page.clock.install()
	const timestamp = await dialog
		.locator('p')
		.filter({ hasText: /Snapshot / })
		.innerText()
	await dialog.getByLabel('Event Hub statistics refresh interval').selectOption('15')
	await page.clock.fastForward(15001)
	await expect(dialog.locator('p').filter({ hasText: /Snapshot / })).not.toHaveText(timestamp)
	await dialog.getByLabel('Event Hub statistics refresh interval').selectOption('0')
	await page.clock.resume()
	await mkdir('artifacts/validation-0.45.0', { recursive: true })
	await page.screenshot({
		path: 'artifacts/validation-0.45.0/statistics-light.png',
		animations: 'disabled',
	})
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await page.getByRole('button', { name: 'Statistics…', exact: true }).click()
	await expect(table).toBeVisible()
	await page.screenshot({
		path: 'artifacts/validation-0.45.0/statistics-dark.png',
		animations: 'disabled',
	})
})
test('shows unavailable partitions separately and cancels a slow refresh', async () => {
	await connect('stats-partial')
	await page.getByRole('button', { name: 'Statistics…', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('1 unavailable')
	await expect(dialog).toContainText('Partition metadata unavailable')
	await page.keyboard.press('Escape')
	await page.getByLabel('Open Event Hub by name').fill('stats-slow')
	await page.getByRole('button', { name: 'Open hub', exact: true }).click()
	await page.getByRole('button', { name: 'Statistics…', exact: true }).click()
	await dialog.getByRole('button', { name: 'Cancel statistics refresh' }).click()
	await expect(dialog.getByRole('button', { name: 'Refresh statistics' })).toBeEnabled()
	await expect(dialog.getByRole('table')).toHaveCount(0)
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Disconnect Event Hubs', exact: true }).click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
})
test('shows actual read bytes, rates and SDK timings and clears them on disconnect', async () => {
	await connect()
	await partition()
	await read()
	const stats = page.getByRole('region', { name: 'Read statistics', exact: true })
	await expect(stats).toContainText('Events / second')
	await expect(stats).toContainText('4 /')
	await stats.getByText('SDK receive call timings', { exact: true }).click()
	await expect(stats).toContainText('3 successful · 0 failed/cancelled · 0 empty')
	await expect(stats).not.toContainText('NaN')
	await page.getByRole('button', { name: 'Disconnect Event Hubs', exact: true }).click()
	await expect(stats).toHaveCount(0)
})

test('retains aggregate listener statistics after cancellation and shows partition rates', async () => {
	await connect('listen-paced')
	await page.getByRole('button', { name: 'Listen to all partitions…', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Listener concurrency').fill('2')
	await dialog.getByLabel('Listener event limit').fill('100')
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed the listener target, starting position and limits.',
		})
		.check()
	await dialog.getByRole('button', { name: 'Start all-partition listener', exact: true }).click()
	const stats = dialog.getByRole('region', { name: 'Listener statistics', exact: true })
	await expect(stats).toContainText('Retained body bytes')
	await expect(dialog.getByRole('table', { name: 'Listener partition progress' })).toContainText(
		'Events / second',
	)
	await expect(dialog).toContainText(/2 \/ 100 events/)
	await dialog.getByRole('button', { name: 'Cancel Event Hubs listener', exact: true }).click()
	await expect(dialog).toContainText('Cancelled.')
	await stats.getByText('SDK receive call timings', { exact: true }).click()
	await expect(stats).toContainText('successful')
	await expect(stats).not.toContainText('NaN')
	await page.screenshot({
		path: 'artifacts/validation-0.45.0/listener-statistics.png',
		animations: 'disabled',
	})
})
test('shows confirmed sender bytes and batch timings in the retained receipt', async () => {
	await connect()
	await page.getByRole('button', { name: 'Send events…', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Event body format').selectOption('text')
	await dialog.getByLabel('Event body', { exact: true }).fill('hello')
	await dialog.getByLabel('Event send repetitions').fill('3')
	await dialog.getByLabel('Event send batch size').fill('2')
	await dialog.getByRole('checkbox', { name: /I understand this publishes/ }).check()
	await dialog.getByRole('button', { name: 'Send events', exact: true }).click()
	const stats = dialog.getByRole('region', { name: 'Send statistics', exact: true })
	await expect(stats).toContainText('15 B')
	await stats.getByText('SDK send call timings', { exact: true }).click()
	await expect(stats).toContainText('2 successful · 0 failed/cancelled')
	await expect(stats).toContainText('uncertain batches are excluded')
})
