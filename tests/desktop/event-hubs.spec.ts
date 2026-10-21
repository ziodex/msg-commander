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
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.25.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.25.0/${name}.png` })
}
test('opens a known hub, reads exact event metadata and inspects JSON and binary events in a modal', async () => {
	await expect(
		page.getByRole('button', { name: 'Connect Event Hubs', exact: true }),
	).toBeDisabled()
	await connect()
	await partition()
	await expect(
		page.getByText('9007199254740993 – 9007199254740995', { exact: true }),
	).toBeVisible()
	await read()
	const result = page.getByRole('region', { name: 'Event read results', exact: true })
	await expect(result).toContainText('3 events read. Event limit reached.')
	await expect(result.locator('tbody tr')).toHaveCount(3)
	await screenshot('event-hubs-read')
	await result
		.getByRole('button', { name: 'Inspect event 9007199254740993', exact: true })
		.click()
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('18446744073709551615')
	await expect(dialog).toContainText('Partition key device-1')
	await expect(dialog.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await expect(dialog.getByRole('button', { name: 'Move dialog', exact: true })).toBeVisible()
	await expect(dialog.getByRole('button', { name: 'Resize dialog', exact: true })).toBeVisible()
	await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
	await expect(dialog.getByTestId('event-body')).toContainText('"temperature": 21')
	await screenshot('event-hubs-inspector')
	await page.keyboard.press('Escape')
	await result
		.getByRole('button', { name: 'Inspect event 9007199254740994', exact: true })
		.click()
	await expect(dialog).toContainText('not valid UTF-8')
	await dialog.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(dialog.getByTestId('event-body')).toContainText('00 ff 80 41')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Use position after last event', exact: true }).click()
	await expect(page.getByLabel('Event start position', { exact: true })).toHaveValue('offset')
	await expect(page.getByLabel('Event position value', { exact: true })).toHaveValue(
		'offset:three',
	)
	await expect(
		page.getByRole('checkbox', { name: 'Include the event at this position' }),
	).not.toBeChecked()
})
test('browses paged hubs and consumer groups with ARM and navigates partitions in the tree', async () => {
	await page
		.getByRole('checkbox', {
			name: 'Browse hubs and consumer groups with Entra management access',
		})
		.check()
	await page
		.getByLabel('Event Hubs namespace resource ID')
		.fill(
			'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture',
		)
	await page.getByLabel('Event Hubs management tenant').fill('fixture')
	await page
		.getByLabel('Event Hubs management client')
		.fill('22222222-2222-4222-8222-222222222222')
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: '▸ telemetry', exact: true }).click()
	await page.getByRole('button', { name: 'More consumer groups', exact: true }).click()
	await expect(page.locator('.eh-branch summary').filter({ hasText: /^audit$/ })).toBeVisible()
	await page
		.locator('.eh-branch summary')
		.filter({ hasText: /^dashboard$/ })
		.click()
	await partition('telemetry', '1', 'dashboard')
	await expect(page.getByText('Empty', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'More hubs', exact: true }).click()
	await expect(page.getByRole('button', { name: '▸ archive', exact: true })).toBeVisible()
	await screenshot('event-hubs-tree')
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await expect(
		page.getByRole('complementary', { name: 'Event Hubs entities', exact: true }),
	).toBeHidden()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect(page.getByRole('button', { name: '▸ archive', exact: true })).toBeVisible()
})
test('validates read limits and positions and keeps count and time results separate', async () => {
	await connect()
	await partition()
	await page.getByLabel('Event read count').fill('101')
	await expect(page.getByRole('button', { name: 'Read events', exact: true })).toBeDisabled()
	await page.getByLabel('Event read count').fill('1')
	await page.getByLabel('Event start position').selectOption('sequence')
	await page.getByLabel('Event position value').fill('9223372036854775808')
	await expect(page.getByRole('button', { name: 'Read events', exact: true })).toBeDisabled()
	await page.getByLabel('Event position value').fill('9007199254740993')
	await page.getByRole('checkbox', { name: 'Include the event at this position' }).uncheck()
	await read(1)
	await expect(
		page.getByRole('region', { name: 'Event read results', exact: true }).locator('tbody tr'),
	).toContainText('9007199254740994')
	await page.locator('.eh-read-settings > summary').click()
	await page.getByLabel('Event start position').selectOption('latest')
	await read(10, 1)
	await expect(
		page.getByRole('region', { name: 'Event read results', exact: true }),
	).toContainText(
		'0 events read. Time limit reached; this does not prove the partition is empty.',
	)
})
test('cancels with a partial inspectable result and preserves it when switching service views', async () => {
	await connect('paced')
	await partition('paced')
	await read(100, 30)
	await expect(
		page.getByRole('region', { name: 'Event read results', exact: true }),
	).toContainText(/1 events read/)
	await screenshot('event-hubs-running')
	await page.getByRole('button', { name: 'Cancel event read', exact: true }).click()
	const result = page.getByRole('region', { name: 'Event read results', exact: true })
	await expect(result).toContainText('Cancelled.')
	await expect(
		result.getByRole('button', { name: 'Inspect event 9007199254740993', exact: true }),
	).toBeEnabled()
	await screenshot('event-hubs-cancelled')
	await page.getByRole('button', { name: 'Service Bus', exact: true }).click()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline events fixture.servicebus.windows.net', exact: true })
		.click()
	await expect(result).toContainText('Cancelled.')
	await page.getByRole('button', { name: 'Disconnect Event Hubs', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Connect Event Hubs', exact: true }),
	).toBeVisible()
	await expect(result).toHaveCount(0)
})
test('pages event body bytes and resets the connection on renderer reload', async () => {
	await connect('large')
	await partition('large')
	await read(1)
	await page.getByRole('button', { name: 'Inspect event 9007199254740993', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('Bytes 0–65536 of 70000')
	await expect(dialog.getByRole('button', { name: 'JSON', exact: true })).toBeDisabled()
	await dialog.getByRole('button', { name: 'Next event body range', exact: true }).click()
	await expect(dialog).toContainText('Bytes 65536–70000 of 70000')
	await dialog.getByRole('button', { name: 'Previous event body range', exact: true }).click()
	await expect(dialog).toContainText('Bytes 0–65536 of 70000')
	await page.reload()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline events fixture.servicebus.windows.net', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Connect Event Hubs', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('tree', { name: 'Event Hubs tree', exact: true })).toHaveCount(0)
})
test('cancels management sign-in using the tracked operation and permits another connection', async () => {
	await page
		.getByRole('checkbox', {
			name: 'Browse hubs and consumer groups with Entra management access',
		})
		.check()
	await page
		.getByLabel('Event Hubs namespace resource ID')
		.fill(
			'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture',
		)
	await page.getByLabel('Event Hubs management tenant').fill('slow')
	await page
		.getByLabel('Event Hubs management client')
		.fill('22222222-2222-4222-8222-222222222222')
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await expect(page.getByText('OFFLINE-EVENTS', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Cancel Event Hubs operation', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Connect Event Hubs', exact: true }),
	).toBeEnabled()
	await page
		.getByRole('checkbox', {
			name: 'Browse hubs and consumer groups with Entra management access',
		})
		.uncheck()
	await connect()
})
