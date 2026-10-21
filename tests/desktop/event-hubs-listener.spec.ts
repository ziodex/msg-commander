import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture is excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-event-listeners-'))
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
async function connect(hub = 'listen-many') {
	await page.getByLabel('Known Event Hub name', { exact: true }).fill(hub)
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await expect(page.getByText('Event Hubs connected', { exact: true })).toBeVisible()
}
const modal = () => page.getByRole('dialog')
async function open() {
	await page.getByRole('button', { name: 'Listen to all partitions…', exact: true }).click()
	return modal()
}
async function run(count = 24, seconds = 10, concurrency = 2) {
	const d = modal()
	if (!(await d.getByLabel('Listener concurrency').isVisible()))
		await d.locator('summary').filter({ hasText: 'Listener settings' }).click()
	await d.getByLabel('Listener concurrency').fill(String(concurrency))
	await d.getByLabel('Listener event limit').fill(String(count))
	await d.getByLabel('Listener time limit').fill(String(seconds))
	await d
		.getByRole('checkbox', {
			name: 'I reviewed the listener target, starting position and limits.',
		})
		.check()
	await d.getByRole('button', { name: 'Start all-partition listener', exact: true }).click()
}
async function fileDialogs(openFiles: string[] = [], saveFile = '') {
	await app.evaluate(
		({ dialog }, v) => {
			dialog.showOpenDialog = async () => ({
				canceled: !v.openFiles.length,
				filePaths: v.openFiles,
			})
			dialog.showSaveDialog = async () => ({ canceled: !v.saveFile, filePath: v.saveFile })
		},
		{ openFiles, saveFile },
	)
}
async function shot(name: string) {
	await mkdir('artifacts/validation-0.28.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.28.0/${name}.png` })
}
test('listens to every partition with bounded progress and inspects exact events in a modal', async () => {
	await connect()
	await open()
	await run()
	await expect(
		modal().getByRole('progressbar', { name: 'Event Hubs listener progress' }),
	).toBeVisible()
	await expect(
		modal().getByRole('table', { name: 'Listener partition progress' }).locator('tbody tr'),
	).toHaveCount(8)
	await shot('event-listener-running')
	await expect(
		modal().getByRole('region', { name: 'Event Hubs listener results' }),
	).toContainText('24 events retained across 8 partitions. Event limit reached.', {
		timeout: 15000,
	})
	await expect(
		modal().getByRole('table', { name: 'Listener partition progress' }).locator('tbody tr'),
	).toHaveCount(8)
	await expect(
		modal().getByRole('table', { name: 'Retained listener events' }).locator('tbody tr'),
	).toHaveCount(24)
	await shot('event-listener-result')
	await modal()
		.getByRole('button', { name: 'Inspect listener event 7 9007199254740993', exact: true })
		.click()
	await expect(modal().getByTestId('event-body')).toContainText('temperature')
	await expect(modal()).toContainText('18446744073709551615')
})
test('saves, loads and resumes a local checkpoint without repeating already retained events', async () => {
	await connect('telemetry')
	await open()
	await run(1, 3)
	await expect(modal()).toContainText('1 events retained across 2 partitions.')
	const path = join(directory, 'checkpoint.json')
	await fileDialogs([], path)
	await modal().getByRole('button', { name: 'Save checkpoint…', exact: true }).click()
	await expect(modal()).toContainText('Saved checkpoint.json')
	const saved = JSON.parse(await readFile(path, 'utf8'))
	expect(saved.partitions[0].position).toEqual({
		kind: 'sequence',
		value: '9007199254740993',
		inclusive: false,
	})
	await fileDialogs([path])
	await modal().getByRole('button', { name: 'Load checkpoint…', exact: true }).click()
	await expect(modal().getByLabel('Listener start position')).toHaveValue('checkpoint')
	await expect(
		modal().getByRole('checkbox', { name: /I reviewed the listener/ }),
	).not.toBeChecked()
	await run(2, 3)
	await expect(modal()).toContainText('2 events retained across 2 partitions.')
	await expect(
		modal().getByRole('table', { name: 'Retained listener events' }),
	).not.toContainText('9007199254740993')
	await shot('event-listener-resume')
})
test('cancels listening after closing and reopening progress and retains results across service views', async () => {
	await connect('listen-paced')
	await open()
	await modal().getByLabel('Listener start position').selectOption('time')
	await modal().getByLabel('Listener start time').fill('2020-01-01T00:00:00Z')
	await run(100, 30, 2)
	await expect(modal()).toContainText('2 active receivers')
	await page.keyboard.press('Escape')
	await expect(modal()).toHaveCount(0)
	await page.getByRole('button', { name: 'Service Bus', exact: true }).click()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline events fixture.servicebus.windows.net', exact: true })
		.click()
	await page.getByRole('button', { name: 'Listener progress…', exact: true }).click()
	await expect(modal().getByLabel('Listener Event Hub')).toHaveValue('listen-paced')
	await expect(modal().getByLabel('Listener start position')).toHaveValue('time')
	await expect(modal().getByLabel('Listener start time')).toHaveValue('2020-01-01T00:00:00Z')
	await modal().getByRole('button', { name: 'Cancel Event Hubs listener', exact: true }).click()
	await expect(modal()).toContainText('Cancelled.')
	await expect(
		modal().getByRole('button', { name: 'Save checkpoint…', exact: true }),
	).toBeEnabled()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Service Bus', exact: true }).click()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline events fixture.servicebus.windows.net', exact: true })
		.click()
	await page.getByRole('button', { name: 'Listener result…', exact: true }).click()
	await expect(modal()).toContainText('Cancelled.')
})
test('validates concurrency, resets acknowledgement and rejects mismatched checkpoint files', async () => {
	await connect('telemetry')
	await open()
	await modal().getByLabel('Listener concurrency').fill('17')
	await modal()
		.getByRole('checkbox', { name: /I reviewed the listener/ })
		.check()
	await expect(
		modal().getByRole('button', { name: 'Start all-partition listener', exact: true }),
	).toBeDisabled()
	await modal().getByLabel('Listener concurrency').fill('2')
	await expect(
		modal().getByRole('checkbox', { name: /I reviewed the listener/ }),
	).not.toBeChecked()
	const path = join(directory, 'wrong.json')
	await writeFile(
		path,
		JSON.stringify({
			format: 'msg-commander/event-checkpoints',
			version: 1,
			namespace: 'different.servicebus.windows.net',
			hubName: 'telemetry',
			consumerGroup: '$Default',
			hubCreatedAt: '2026-10-10T10:00:00Z',
			savedAt: new Date().toISOString(),
			partitions: [
				{
					partitionId: '0',
					retentionFloor: '0',
					position: { kind: 'sequence', value: '0', inclusive: true },
				},
			],
		}),
	)
	await fileDialogs([path])
	await modal().getByRole('button', { name: 'Load checkpoint…', exact: true }).click()
	await expect(modal().getByRole('alert')).toContainText('must match')
})
test('imports raw JSON and binary bodies, saves drafts and sends only after explicit review', async () => {
	await connect('send-normal')
	await page.getByRole('button', { name: 'Send events…', exact: true }).click()
	const d = modal(),
		json = join(directory, 'data.json'),
		binary = join(directory, 'data.bin'),
		saved = join(directory, 'drafts.json')
	await writeFile(json, '{"n":9007199254740993,"city":"Málaga 🚀"}')
	await writeFile(binary, Buffer.from([0, 255, 128, 65]))
	await fileDialogs([json, binary])
	await d.getByRole('button', { name: 'Import event files…', exact: true }).click()
	await d.getByLabel('Event import format').selectOption('body')
	await d.getByRole('button', { name: 'Choose event files…', exact: true }).click()
	await d.getByRole('checkbox', { name: 'Import event 1 from data.json', exact: true }).check()
	await d.getByRole('checkbox', { name: 'Import event 1 from data.bin', exact: true }).check()
	await shot('event-import-preview')
	await d
		.getByRole('button', { name: 'Replace drafts with selected events', exact: true })
		.click()
	await expect(d.getByLabel('Event body', { exact: true })).toHaveValue(
		'{"n":9007199254740993,"city":"Málaga 🚀"}',
	)
	await expect(d.getByRole('button', { name: 'Send events', exact: true })).toBeDisabled()
	await d.getByRole('button', { name: 'Event draft 2', exact: true }).click()
	await expect(d.getByLabel('Event body', { exact: true })).toHaveValue('AP+AQQ==')
	await fileDialogs([], saved)
	await d.getByRole('button', { name: 'Save event drafts…', exact: true }).click()
	await expect(d).toContainText('Saved 2 drafts')
	expect(JSON.parse(await readFile(saved, 'utf8')).events).toHaveLength(2)
	await d.getByRole('checkbox', { name: /I understand this publishes/ }).check()
	await d.getByRole('button', { name: 'Send events', exact: true }).click()
	await expect(d).toContainText('2 events confirmed in 1 batches.')
})
test('exports listener events and loads an archive selection into the composer without publishing', async () => {
	await connect('telemetry')
	await open()
	await run(3, 3)
	await expect(modal()).toContainText('3 events retained')
	const path = join(directory, 'events.json')
	await fileDialogs([], path)
	await modal().getByRole('button', { name: 'Export listener events…', exact: true }).click()
	await expect(modal()).toContainText('Saved 3 events')
	const archive = JSON.parse(await readFile(path, 'utf8'))
	expect(archive.events[1].bodyBase64).toBe('AP+AQQ==')
	expect(archive.events[1].source.partitionId).toBe('0')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Send events…', exact: true }).click()
	await fileDialogs([path])
	await modal().getByRole('button', { name: 'Import event files…', exact: true }).click()
	await modal().getByRole('button', { name: 'Choose event files…', exact: true }).click()
	await modal()
		.getByRole('checkbox', { name: 'Import event 2 from events.json', exact: true })
		.check()
	await modal()
		.getByRole('button', { name: 'Replace drafts with selected events', exact: true })
		.click()
	await expect(modal().getByLabel('Event body', { exact: true })).toHaveValue('AP+AQQ==')
	await expect(modal().getByRole('button', { name: 'Send events', exact: true })).toBeDisabled()
})

test('opens a scoped all-partition listener from the SAS-only hub tree menu', async () => {
	await connect('telemetry')
	await page.getByRole('button', { name: /^[▸▾] telemetry$/ }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Listen to all partitions…', exact: true }).click()
	await expect(modal().getByLabel('Listener Event Hub')).toHaveValue('telemetry')
	await expect(modal().getByLabel('Listener consumer group')).toHaveValue('$Default')
	await run(1, 3)
	await expect(modal()).toContainText('1 events retained across 2 partitions.')
})
