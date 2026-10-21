import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
let app: ElectronApplication, page: Page, directory: string
const packaged = process.env.COMMANDER_PACKAGED === '1'
const fixture = (name: string) => resolve('tests/fixtures/body-tools', name)
const modal = () => page.getByRole('dialog', { name: 'Body tools', exact: true })
function executable() {
	if (process.env.COMMANDER_PACKAGED_EXECUTABLE)
		return resolve(process.env.COMMANDER_PACKAGED_EXECUTABLE)
	if (process.platform === 'darwin')
		return resolve(
			`release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Msg Commander.app/Contents/MacOS/Msg Commander`,
		)
	if (process.platform === 'win32') return resolve('release/win-unpacked/msg-commander.exe')
	return resolve('release/linux-unpacked/msg-commander')
}
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-body-codecs-'))
	await mkdir('artifacts/validation-0.53.0', { recursive: true })
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
		),
	)
	app = await electron.launch({
		...(packaged ? { executablePath: executable() } : {}),
		args: [...(packaged ? [] : ['.']), `--user-data-dir=${directory}`],
		env: { ...env, ...(!packaged ? { COMMANDER_TEST_HOST: '1' } : {}) },
	})
	page = await app.firstWindow()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
		timeout: 20000,
	})
})
test.afterEach(async () => {
	await app?.close()
	await rm(directory, { recursive: true, force: true })
})
async function dialogs(openPath = '', savePath = '') {
	await app.evaluate(
		({ dialog }, paths) => {
			dialog.showOpenDialog = async () => ({
				canceled: !paths.openPath,
				filePaths: paths.openPath ? [paths.openPath] : [],
			})
			dialog.showSaveDialog = async () => ({
				canceled: !paths.savePath,
				filePath: paths.savePath,
			})
		},
		{ openPath, savePath },
	)
}
async function open() {
	await page.getByRole('button', { name: 'Body tools', exact: true }).click()
}
async function load(name: string) {
	await dialogs(fixture(name))
	await modal().getByRole('button', { name: 'Open body file…' }).click()
	await expect(modal().getByRole('status')).toContainText('Loaded')
}
async function convert() {
	await modal().getByRole('button', { name: 'Convert body', exact: true }).click()
	await expect(modal().getByRole('region', { name: 'Converted body review' })).toBeVisible()
}
test('decodes GZip from a native file selection and saves exact reviewed bytes without touching the source', async () => {
	const original = await readFile(fixture('gzip.bin'))
	await open()
	await load('gzip.bin')
	await modal().getByLabel('Codec compression').selectOption('gzip')
	await convert()
	await expect(modal().getByTestId('codec-output')).toContainText('España — 東京 👋')
	await expect(modal().getByTestId('codec-output')).toContainText('9223372036854775807')
	const destination = join(directory, 'decoded.txt')
	await dialogs('', destination)
	await modal().getByRole('button', { name: 'Save converted body…' }).click()
	await expect(modal().getByRole('status')).toContainText('Saved converted body')
	expect(await readFile(destination)).toEqual(gunzipSync(original))
	expect(await readFile(fixture('gzip.bin'))).toEqual(original)
	await modal().getByLabel('Codec text encoding').selectOption('ascii')
	await expect(modal().getByRole('region', { name: 'Converted body review' })).toHaveCount(0)
})
test('encodes explicit UTF-16 with a BOM and refuses malformed compression while retaining the source', async () => {
	await open()
	await modal().getByLabel('Codec operation').selectOption('encode')
	await modal().getByLabel('Codec text encoding').selectOption('utf16le')
	await modal()
		.getByRole('checkbox', { name: 'Include a byte-order mark when encoding text' })
		.check()
	await modal().getByLabel('Codec source body').fill('España')
	await convert()
	await expect(modal().getByTestId('codec-output')).toContainText(
		'ff fe 45 00 73 00 70 00 61 00 f1 00 61 00',
	)
	await modal().getByLabel('Codec operation').selectOption('decode')
	await modal().getByLabel('Codec compression').selectOption('gzip')
	await modal().getByLabel('Codec source representation').selectOption('base64')
	await modal().getByLabel('Codec source body').fill('H4sIAA==')
	await modal().getByRole('button', { name: 'Convert body', exact: true }).click()
	await expect(modal().getByRole('alert')).toContainText(
		'Truncated, trailing, corrupt or oversized data was refused',
	)
	await expect(modal().getByLabel('Codec source body')).toHaveValue('H4sIAA==')
	await expect(modal().getByRole('region', { name: 'Converted body review' })).toHaveCount(0)
})
test('clears replaced reviews on file cancellation and renders XML as text without executing it', async () => {
	await page.getByRole('button', { name: /Switch to dark theme/ }).click()
	await open()
	await modal()
		.getByLabel('Codec source body')
		.fill('<script>window.CODEC_EXECUTED=true</script>')
	await convert()
	expect(await page.evaluate(() => 'CODEC_EXECUTED' in window)).toBe(false)
	await dialogs()
	await modal().getByRole('button', { name: 'Open body file…' }).click()
	await expect(modal().getByText('File selection cancelled.', { exact: true })).toBeVisible()
	await expect(modal().getByRole('region', { name: 'Converted body review' })).toHaveCount(0)
	await expect(modal().getByLabel('Codec body format').locator('option')).toHaveCount(2)
})
async function profile(service: 'Service Bus' | 'Event Hubs') {
	await page.getByRole('button', { name: service, exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Codec fixture')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
}
test('enables codecs for complete inspector bytes and disables partial body windows', async () => {
	test.skip(
		packaged,
		'Requires the offline Service Bus fixture, which is excluded from packages.',
	)
	await profile('Service Bus')
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await page.getByRole('button', { name: '9007199254740993 order-001', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(inspector.getByRole('button', { name: 'Body tools…', exact: true })).toBeEnabled()
	await inspector.getByRole('button', { name: 'Body tools…', exact: true }).click()
	await convert()
	await expect(modal().getByTestId('codec-output')).toContainText('Málaga 🚀')
	await modal().getByRole('button', { name: 'Close body codecs', exact: true }).click()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'large Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await page.getByRole('button', { name: '1 large', exact: true }).click()
	await expect(inspector.getByRole('button', { name: 'Body tools…', exact: true })).toBeDisabled()
	for (let i = 0; i < 3; i++)
		await inspector.getByRole('button', { name: 'Load more bytes', exact: true }).click()
	await inspector.getByRole('button', { name: 'Next body range', exact: true }).click()
	await expect(
		inspector.getByText('Bytes 262144–300000 of 300000', { exact: true }),
	).toBeVisible()
	await expect(inspector.getByRole('button', { name: 'Body tools…', exact: true })).toBeDisabled()
})
test('uses converted bytes in a Service Bus draft only after review and keeps the subject and content type', async () => {
	test.skip(
		packaged,
		'Requires the offline Service Bus fixture, which is excluded from packages.',
	)
	await profile('Service Bus')
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const composer = page.getByRole('dialog', { name: 'Compose message', exact: true })
	await page.getByLabel('Message subject', { exact: true }).fill('Keep subject')
	await page.getByLabel('Message ID', { exact: true }).fill('')
	await composer.getByRole('button', { name: 'Body tools…', exact: true }).click()
	await modal().getByLabel('Codec operation').selectOption('encode')
	await modal().getByLabel('Codec compression').selectOption('gzip')
	await convert()
	await expect(page.getByLabel('Message subject', { exact: true })).toHaveValue('Keep subject')
	await modal().getByRole('button', { name: 'Use converted body in draft' }).click()
	await expect(modal()).toHaveCount(0)
	await expect(page.getByLabel('Message body', { exact: true })).toHaveValue(/^H4sI/)
	await expect(page.getByLabel('Content type', { exact: true })).toHaveValue('application/json')
	await expect(page.getByLabel('Message subject', { exact: true })).toHaveValue('Keep subject')
})
test('uses reviewed conversion in the current Event Hubs draft and preserves its metadata', async () => {
	test.skip(packaged, 'Requires the offline Event Hubs fixture, which is excluded from packages.')
	await profile('Event Hubs')
	await page.getByLabel('Known Event Hub name', { exact: true }).fill('telemetry')
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'Send events…', exact: true }).click()
	const composer = page
		.getByRole('dialog')
		.filter({ has: page.getByLabel('Event body', { exact: true }) })
	await page.getByLabel('Event correlation ID', { exact: true }).fill('keep-correlation')
	await composer.getByRole('button', { name: 'Body tools…', exact: true }).click()
	await modal().getByLabel('Codec operation').selectOption('encode')
	await modal().getByLabel('Codec body format').selectOption('text')
	await modal().getByLabel('Codec text encoding').selectOption('utf16le')
	await convert()
	await modal().getByRole('button', { name: 'Use converted body in draft' }).click()
	await expect(page.getByLabel('Event body format', { exact: true })).toHaveValue('base64')
	await expect(page.getByLabel('Event correlation ID', { exact: true })).toHaveValue(
		'keep-correlation',
	)
	await expect(page.getByLabel('Event content type', { exact: true })).toHaveValue(
		'application/json',
	)
})
