import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture executable is deliberately excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-service-bus-'))
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
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline namespace')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Recovery namespace')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('recovery.fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://recovery.fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-destination-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page
		.getByRole('button', {
			name: 'Offline namespace fixture.servicebus.windows.net',
			exact: true,
		})
		.click()
	await page.getByRole('button', { name: 'Connect and browse' }).click()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
const dialog = () => page.getByRole('dialog', { name: 'Resend dead-letter messages', exact: true })
async function seed(id = 'recovery-original') {
	await page.getByRole('button', { name: 'empty Active', exact: true }).click()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const composer = page.getByRole('dialog')
	await composer.getByLabel('Message ID', { exact: true }).fill(id)
	await composer.getByLabel('Message body', { exact: true }).fill('{"exact":9007199254740993}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	const message = page.getByRole('article', { name: `Received ${id}`, exact: true })
	await message.getByRole('button', { name: 'Dead-letter received', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Confirm dead-letter', exact: true })
		.click()
	await expect(message).toContainText('dead-lettered')
	await page.getByRole('button', { name: 'Close receiver', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Close and let locks expire', exact: true })
		.click()
}
async function open() {
	await page.getByRole('button', { name: 'empty Active', exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Resend dead-letter messages…', exact: true }).click()
}
async function chooseDestination() {
	await dialog()
		.getByLabel('Resend destination connection')
		.selectOption({ label: 'Recovery namespace — recovery.fixture.servicebus.windows.net' })
}
async function acknowledge() {
	await dialog()
		.getByRole('checkbox', {
			name: 'I have reviewed the destination, message IDs and original-message behavior.',
			exact: true,
		})
		.check()
}
async function removeMode() {
	await dialog()
		.getByRole('radio', { name: 'Remove originals after successful resend', exact: true })
		.check()
	await dialog()
		.getByRole('checkbox', { name: /I understand a confirmed destination send/ })
		.check()
	await acknowledge()
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.22.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.22.0/${name}.png` })
}
test('keeps originals by default, uses the reviewed namespace and exports a credential-free receipt', async () => {
	await seed()
	await open()
	await chooseDestination()
	await expect(
		dialog().getByRole('radio', {
			name: 'Keep originals in the dead-letter queue',
			exact: true,
		}),
	).toBeChecked()
	await expect(dialog()).toContainText('Cross-namespace recovery uses separate sends')
	await acknowledge()
	await screenshot('cross-namespace-configuration')
	await dialog().getByRole('button', { name: 'Start resend', exact: true }).click()
	const result = dialog().getByRole('region', { name: 'Resend result' })
	await expect(result).toContainText('1 resends confirmed · 0 originals removed · 0 uncertain')
	await expect(result).toContainText('recovery.fixture.servicebus.windows.net / queue/empty')
	const path = join(directory, 'recovery-receipt.json')
	await app.evaluate(({ dialog }, filePath) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath })
	}, path)
	await result.getByRole('button', { name: 'Save resend receipt', exact: true }).click()
	await expect(dialog()).toContainText('Saved recovery-receipt.json')
	const text = await readFile(path, 'utf8'),
		receipt = JSON.parse(text)
	expect(text).not.toContain('not-a-real')
	expect(receipt.result).toMatchObject({
		sourceNamespace: 'fixture.servicebus.windows.net',
		destinationNamespace: 'recovery.fixture.servicebus.windows.net',
		sent: 1,
		removed: 0,
	})
	expect(receipt.result.transfers[0]).toMatchObject({
		originalMessageId: 'recovery-original',
		send: 'confirmed',
		source: 'kept',
	})
	await result.getByText('Per-message recovery receipt (1)', { exact: true }).click()
	await screenshot('cross-namespace-result')
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await expect(
		page.getByRole('heading', { name: 'Offline namespace', exact: true }),
	).toBeVisible()
	await page
		.getByRole('button', {
			name: 'Recovery namespace recovery.fixture.servicebus.windows.net',
			exact: true,
		})
		.click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await page.getByRole('button', { name: 'empty Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table')).toContainText(receipt.result.outgoingMessageId)
})
test('requires acknowledgement for separate completion and clears confirmations when destination changes', async () => {
	await seed()
	await open()
	await chooseDestination()
	await dialog()
		.getByRole('radio', { name: 'Remove originals after successful resend', exact: true })
		.check()
	await acknowledge()
	const run = dialog().getByRole('button', { name: 'Start resend', exact: true })
	await expect(run).toBeDisabled()
	await expect(dialog().getByLabel('Resend confirmation', { exact: true })).toHaveCount(0)
	const ack = dialog().getByRole('checkbox', {
		name: /I understand a confirmed destination send/,
	})
	await ack.check()
	await expect(run).toBeEnabled()
	await dialog().getByLabel('Resend destination name').fill('archive')
	await expect(ack).not.toBeChecked()
	await expect(run).toBeDisabled()
	await ack.check()
	await acknowledge()
	await run.click()
	await expect(dialog().getByRole('region', { name: 'Resend result' })).toContainText(
		'1 resends confirmed · 1 originals removed · 0 uncertain',
	)
})
test('a rejected completion retains the confirmed copy and requires review before another resend', async () => {
	await seed('purge-reject-complete')
	await open()
	await chooseDestination()
	await removeMode()
	await dialog().getByRole('button', { name: 'Start resend', exact: true }).click()
	const result = dialog().getByRole('region', { name: 'Resend result' })
	await expect(result).toContainText('1 confirmed copy has no confirmed source removal')
	await expect(result).toContainText('not-removed')
	await screenshot('cross-namespace-partial')
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await open()
	await acknowledge()
	await expect(dialog().getByRole('button', { name: 'Start resend', exact: true })).toBeDisabled()
	await expect(dialog()).toContainText('recovery.fixture.servicebus.windows.net')
	await dialog()
		.getByRole('checkbox', {
			name: 'I have reviewed the confirmed copies without source removal before another resend.',
			exact: true,
		})
		.check()
	await expect(dialog().getByRole('button', { name: 'Start resend', exact: true })).toBeEnabled()
})
test('cancellation during source completion preserves the destination send and marks removal uncertain', async () => {
	await seed('purge-wait-complete')
	await open()
	await chooseDestination()
	await removeMode()
	await dialog().getByRole('button', { name: 'Start resend', exact: true }).click()
	const result = dialog().getByRole('region', { name: 'Resend result' })
	await expect(result).toContainText('completing')
	await result.getByRole('button', { name: 'Cancel resend', exact: true }).click()
	await expect(result).toContainText('1 resends confirmed · 0 originals removed · 1 uncertain')
	await expect(result).toContainText(
		'The destination send is confirmed; source completion may have succeeded.',
	)
	await expect(result.getByRole('table')).toContainText('unknown')
})
test('an uncertain destination send leaves the original uncompleted and records the exact outgoing ID', async () => {
	await seed()
	await open()
	await chooseDestination()
	await removeMode()
	await dialog().getByLabel('Resend destination name').fill('resend-unknown-send')
	await removeMode()
	await dialog().getByRole('button', { name: 'Start resend', exact: true }).click()
	const result = dialog().getByRole('region', { name: 'Resend result' })
	await expect(result).toContainText('0 resends confirmed · 0 originals removed · 1 uncertain')
	await expect(result).toContainText('Source completion was not attempted.')
	await expect(result.getByRole('table')).toContainText('not-removed')
	await expect(result.getByRole('table')).toContainText('recovery-original')
})
