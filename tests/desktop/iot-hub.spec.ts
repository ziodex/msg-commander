import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const secret = (hub = 'telemetry') =>
	`Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=service;SharedAccessKey=ZmFrZQ==;EntityPath=${hub}`
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-iot-desktop-'))
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => e[0] !== 'ELECTRON_RUN_AS_NODE' && e[1] !== undefined,
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
	await page.getByRole('button', { name: 'IoT Hub', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function profile(hub = 'telemetry') {
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline IoT')
	await page
		.getByLabel('Event Hubs-compatible connection string', { exact: true })
		.fill(secret(hub))
	await expect(page.getByLabel('Namespace hostname')).toHaveValue(
		'fixture.servicebus.windows.net',
	)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
}
async function connect(hub = 'telemetry', group = '$Default') {
	await profile(hub)
	await page.getByLabel('IoT Hub consumer group', { exact: true }).fill(group)
	await page.getByRole('button', { name: 'Connect IoT Hub', exact: true }).click()
	await expect(page.getByText('IoT Hub connected', { exact: true })).toBeVisible()
}
const modal = () => page.getByRole('dialog')
async function listen(count = 24, seconds = 10) {
	await page.getByRole('button', { name: 'Listen to all partitions…', exact: true }).click()
	await expect(
		modal().getByRole('heading', { name: 'Listen to all IoT Hub partitions', exact: true }),
	).toBeVisible()
	await expect(modal().getByLabel('Listener Event Hub')).toBeDisabled()
	await modal().getByLabel('Listener concurrency').fill('2')
	await modal().getByLabel('Listener event limit').fill(String(count))
	await modal().getByLabel('Listener time limit').fill(String(seconds))
	await modal()
		.getByRole('checkbox', { name: /I reviewed the listener/ })
		.check()
	await modal().getByRole('button', { name: 'Start all-partition listener', exact: true }).click()
}
async function shot(name: string) {
	await mkdir('artifacts/validation-0.29.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.29.0/${name}.png` })
}
test('derives compatible endpoint metadata and rejects device strings with a useful secret-free error', async () => {
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Invalid IoT')
	await expect(page.getByRole('radio', { name: 'Microsoft Entra' })).toHaveCount(0)
	await page
		.getByLabel('Event Hubs-compatible connection string')
		.fill('HostName=fixture.azure-devices.net;DeviceId=sensor-01;SharedAccessKey=DO-NOT-ECHO')
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await expect(modal().getByRole('alert')).toContainText('Built-in endpoints')
	await expect(modal().getByRole('alert')).not.toContainText('DO-NOT-ECHO')
	await page.getByLabel('Event Hubs-compatible connection string').fill(secret())
	await shot('iot-connection')
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Connect IoT Hub', exact: true })).toBeEnabled()
	const data = await readFile(join(directory, 'workspace.json'), 'utf8')
	expect(data).not.toContain('ZmFrZQ')
	expect(data).toContain('iot-hub')
})
test('discovers partitions in an existing consumer group and inspects device identity and binary events', async () => {
	await connect('telemetry', 'audit')
	await expect(
		page.getByRole('button', { name: 'telemetry audit partition 0', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'Send events…', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Create Event Hub…', exact: true })).toHaveCount(
		0,
	)
	await expect(
		page.getByRole('button', { name: 'Namespace SAS policies…', exact: true }),
	).toHaveCount(0)
	await page.getByRole('button', { name: 'telemetry audit partition 0', exact: true }).click()
	await expect(
		page.getByText('9007199254740993 – 9007199254740995', { exact: true }),
	).toBeVisible()
	await page.getByLabel('Event read count').fill('3')
	await page.getByRole('button', { name: 'Read events', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Inspect event 9007199254740993', exact: true }),
	).toBeVisible()
	await shot('iot-partitions')
	await page.getByRole('button', { name: 'Inspect event 9007199254740993', exact: true }).click()
	await expect(modal()).toContainText('sensor-01')
	await expect(modal()).toContainText('iothub-connection-device-id')
	await expect(modal()).toContainText('18446744073709551615')
	await shot('iot-event-inspection')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Inspect event 9007199254740994', exact: true }).click()
	await modal().getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(modal().getByTestId('event-body')).toContainText('00 ff 80 41')
})
test('listens to all partitions with bounded progress and offers only listening in the IoT tree menu', async () => {
	await connect('listen-many')
	await page
		.getByRole('treeitem', { name: 'Event Hub listen-many', exact: true })
		.getByRole('button', { name: 'listen-many', exact: false })
		.first()
		.click({ button: 'right' })
	await expect(
		page.getByRole('menuitem', { name: 'Listen to all partitions…', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('menuitem', { name: 'Delete Event Hub…', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('menuitem', { name: 'SAS policies and keys…', exact: true }),
	).toHaveCount(0)
	await page.keyboard.press('Escape')
	await listen()
	await expect(
		modal().getByRole('table', { name: 'Listener partition progress' }).locator('tbody tr'),
	).toHaveCount(8)
	await shot('iot-listener-progress')
	await expect(modal()).toContainText('24 events retained across 8 partitions.', {
		timeout: 15000,
	})
	await expect(
		modal().getByRole('table', { name: 'Retained listener events' }).locator('tbody tr'),
	).toHaveCount(24)
	await modal()
		.getByRole('button', { name: 'Inspect listener event 7 9007199254740993', exact: true })
		.click()
	await expect(modal()).toContainText('sensor-01')
})
test('cancels after closing and reopening the listener across service views and retains partial results', async () => {
	await connect('listen-paced')
	await listen(100, 30)
	await expect(modal()).toContainText('2 active receivers')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'IoT Hub', exact: true }).click()
	await page
		.getByRole('button', { name: 'Offline IoT fixture.servicebus.windows.net', exact: true })
		.click()
	await page.getByRole('button', { name: 'Listener progress…', exact: true }).click()
	await modal().getByRole('button', { name: 'Cancel IoT Hub listener', exact: true }).click()
	await expect(modal()).toContainText('Cancelled.')
	await expect(
		modal().getByRole('button', { name: 'Save checkpoint…', exact: true }),
	).toBeEnabled()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Disconnect IoT Hub', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Connect IoT Hub', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Listener result…', exact: true })).toHaveCount(0)
})
test('enforces listener bounds and returns an idle time-limited result without implying missing device traffic', async () => {
	await connect()
	await page.getByRole('button', { name: 'Listen to all partitions…', exact: true }).click()
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
	await modal().getByLabel('Listener start position').selectOption('latest')
	await modal().getByLabel('Listener time limit').fill('1')
	await modal()
		.getByRole('checkbox', { name: /I reviewed the listener/ })
		.check()
	await modal().getByRole('button', { name: 'Start all-partition listener', exact: true }).click()
	await expect(modal()).toContainText(
		'0 events retained across 2 partitions. Time limit reached; idle partitions may receive events later.',
	)
})
test('reports ServiceConnect failures without credentials and can cancel connection discovery', async () => {
	await profile('denied')
	await page.getByRole('button', { name: 'Connect IoT Hub', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('ServiceConnect')
	await expect(page.getByRole('alert')).not.toContainText('SECRET')
	await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
	await page.getByLabel('Event Hubs-compatible connection string').fill(secret('connect-slow'))
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByRole('button', { name: 'Connect IoT Hub', exact: true }).click()
	await page.getByRole('button', { name: 'Cancel IoT Hub operation', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Connect IoT Hub', exact: true })).toBeEnabled()
	await expect(page.getByText('IoT Hub connected', { exact: true })).toHaveCount(0)
})
