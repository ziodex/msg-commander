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
	directory = await mkdtemp(join(tmpdir(), 'commander-event-sends-'))
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
async function composer() {
	await page.getByRole('button', { name: 'Send events…', exact: true }).click()
	return page.getByRole('dialog')
}
async function send() {
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('checkbox', { name: /I understand this publishes/ }).check()
	await dialog.getByRole('button', { name: 'Send events', exact: true }).click()
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.26.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.26.0/${name}.png` })
}
test('sends repeated JSON and binary drafts with typed properties to an explicit partition and inspects the result', async () => {
	await connect('send-normal')
	const dialog = await composer()
	await dialog.getByLabel('Event body', { exact: true }).fill('{"temperature":21}')
	await dialog.getByLabel('Event correlation ID').fill('trace-42')
	await dialog.locator('summary').filter({ hasText: 'Application properties' }).click()
	await dialog.getByRole('button', { name: 'Add event property', exact: true }).click()
	await dialog.getByLabel('Event property 1 name').fill('unsigned')
	await dialog.getByLabel('Event property 1 type').selectOption('uint64')
	await dialog.getByLabel('Event property 1 value').fill('18446744073709551615')
	await dialog.getByRole('button', { name: 'Add event draft', exact: true }).click()
	await dialog.getByLabel('Event body format').selectOption('base64')
	await dialog.getByLabel('Event body', { exact: true }).fill('AP+AQQ==')
	await dialog.getByLabel('Event content type').fill('application/octet-stream')
	await dialog.getByLabel('Event send repetitions').fill('2')
	await dialog.getByLabel('Event send batch size').fill('2')
	await dialog.getByLabel('Event send routing').selectOption('partition')
	await dialog.getByLabel('Event routing value').fill('1')
	await screenshot('event-hubs-composer')
	await send()
	await expect(dialog).toContainText('4 events confirmed in 2 batches. Event target reached.')
	await screenshot('event-hubs-send-result')
	await page.keyboard.press('Escape')
	await partition('send-normal', '1')
	await read(4)
	await page.getByRole('button', { name: 'Inspect event 0', exact: true }).click()
	await expect(dialog).toContainText('trace-42')
	await expect(dialog).toContainText('18446744073709551615')
	await expect(dialog.getByTestId('event-body')).toContainText('temperature')
	await expect(dialog).toContainText(/Message ID\s*[0-9a-f-]+:1/)
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Inspect event 1', exact: true }).click()
	await dialog.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(dialog.getByTestId('event-body')).toContainText('00 ff 80 41')
})
test('requires fresh acknowledgement after edits and validates routing, typed values and total count', async () => {
	await connect('send-normal')
	const dialog = await composer(),
		submit = dialog.getByRole('button', { name: 'Send events', exact: true }),
		ack = dialog.getByRole('checkbox', { name: /I understand this publishes/ })
	await expect(submit).toBeDisabled()
	await ack.check()
	await expect(submit).toBeEnabled()
	await dialog.getByLabel('Event body', { exact: true }).fill('{"changed":true}')
	await expect(ack).not.toBeChecked()
	await expect(submit).toBeDisabled()
	await dialog.getByLabel('Event send routing').selectOption('key')
	await ack.check()
	await expect(submit).toBeDisabled()
	await dialog.getByLabel('Event routing value').fill('device-1')
	await dialog.getByLabel('Event send repetitions').fill('1001')
	await ack.check()
	await expect(submit).toBeDisabled()
	await dialog.getByLabel('Event send repetitions').fill('1')
	await dialog.locator('summary').filter({ hasText: 'Application properties' }).click()
	await dialog.getByRole('button', { name: 'Add event property', exact: true }).click()
	await dialog.getByLabel('Event property 1 name').fill('integer')
	await dialog.getByLabel('Event property 1 type').selectOption('int64')
	await dialog.getByLabel('Event property 1 value').fill('9223372036854775808')
	await ack.check()
	await expect(submit).toBeDisabled()
	await dialog.getByLabel('Event property 1 value').fill('9223372036854775807')
	await send()
	await expect(dialog).toContainText('1 events confirmed in 1 batches.')
	await page.keyboard.press('Escape')
	await partition('send-normal')
	await read(1)
	await page.getByRole('button', { name: 'Inspect event 0', exact: true }).click()
	await expect(dialog).toContainText('Partition key device-1')
})
test('requires review of an uncertain batch before another send and preserves receipts across service views', async () => {
	await connect('send-unknown')
	let dialog = await composer()
	await dialog.getByLabel('Event send repetitions').fill('4')
	await dialog.getByLabel('Event send batch size').fill('2')
	await send()
	await expect(dialog).toContainText('The last batch of 2 events may have been accepted.')
	await expect(dialog.getByRole('button', { name: 'Prepare another event send' })).toBeDisabled()
	await screenshot('event-hubs-send-unknown')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Service Bus', exact: true }).click()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline events fixture.servicebus.windows.net', exact: true })
		.click()
	await page.getByRole('button', { name: 'Event send result…', exact: true }).click()
	dialog = page.getByRole('dialog')
	await expect(dialog).toContainText('The last batch of 2 events may have been accepted.')
	await dialog.getByRole('checkbox', { name: /I have reviewed the uncertain batch/ }).check()
	await dialog.getByRole('button', { name: 'Prepare another event send' }).click()
	await expect(
		dialog.getByRole('checkbox', { name: /I understand this publishes/ }),
	).not.toBeChecked()
	await expect(dialog.getByRole('button', { name: 'Send events', exact: true })).toBeDisabled()
})
test('cancels an in-flight batch with visible progress and an uncertain receipt', async () => {
	await connect('send-slow')
	const dialog = await composer()
	await send()
	await expect(dialog).toContainText('sending')
	await expect(dialog.getByRole('progressbar', { name: 'Event send progress' })).toBeVisible()
	await screenshot('event-hubs-send-running')
	await page.keyboard.press('Escape')
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel event send', exact: true }).click()
	await expect(dialog).toContainText(
		'Cancelled. The last batch of 1 events may have been accepted.',
	)
})
test('connects in send-only mode, publishes and disables reading', async () => {
	await page.getByRole('checkbox', { name: 'Connect for sending only', exact: true }).check()
	await connect('send-only')
	await expect(
		page.getByText('Connected for sending. Reconnect in read mode to read events.'),
	).toBeVisible()
	const dialog = await composer()
	await send()
	await expect(dialog).toContainText('1 events confirmed in 1 batches.')
	await page.keyboard.press('Escape')
	await partition('send-only')
	await expect(page.getByRole('button', { name: 'Read events', exact: true })).toBeDisabled()
})
test('shows preflight failure without publishing earlier drafts and supports correction', async () => {
	await connect('send-oversized')
	const dialog = await composer()
	await dialog.getByRole('button', { name: 'Add event draft', exact: true }).click()
	await dialog.getByLabel('Event body', { exact: true }).fill('{"oversized":true}')
	await send()
	await expect(dialog).toContainText('0 events confirmed in 0 batches.')
	await expect(dialog).toContainText('Nothing was sent.')
	await dialog.getByRole('button', { name: 'Prepare another event send' }).click()
	await dialog.getByLabel('Event body', { exact: true }).fill('{"fixed":true}')
	await send()
	await expect(dialog).toContainText('2 events confirmed in 1 batches.')
})
