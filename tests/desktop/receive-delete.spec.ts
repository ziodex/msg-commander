import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
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
	await page.getByRole('button', { name: 'Connect and browse' }).click()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeEnabled()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
const dialog = () => page.getByRole('dialog', { name: 'Receive & delete', exact: true })
const result = () => dialog().getByRole('region', { name: 'Receive-and-delete result' })
async function open(name = 'orders Active') {
	await page.getByRole('button', { name, exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Receive & delete…', exact: true }).click()
	await expect(dialog()).toBeVisible()
}
async function confirm() {
	await dialog()
		.getByRole('checkbox', { name: /I understand messages/ })
		.check()
	await expect(
		dialog().getByLabel('Receive-and-delete confirmation', { exact: true }),
	).toHaveCount(0)
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.20.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.20.0/${name}.png` })
}
test('requires confirmation and bounds, then retains an inspectable consumed copy', async () => {
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Receive & delete…', exact: true }).click()
	const run = dialog().getByRole('button', { name: 'Receive & delete permanently', exact: true })
	await expect(run).toBeDisabled()
	await confirm()
	await dialog().getByLabel('Receive-and-delete count').fill('101')
	await expect(run).toBeDisabled()
	await expect(
		dialog().getByRole('checkbox', { name: /I understand messages/ }),
	).not.toBeChecked()
	await dialog().getByLabel('Receive-and-delete count').fill('1')
	await confirm()
	await expect(run).toBeEnabled()
	await screenshot('receive-delete-confirmation')
	await run.click()
	await expect(result()).toContainText(
		'1 message returned and permanently consumed. Message limit reached.',
	)
	await expect(result().getByRole('button', { name: 'Complete', exact: true })).toHaveCount(0)
	await screenshot('receive-delete-result')
	await result().getByRole('button', { name: 'Inspect consumed message', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Inspect consumed message', exact: true })
	await expect(inspector.getByRole('button', { name: 'Move dialog', exact: true })).toBeVisible()
	await expect(
		inspector.getByRole('button', { name: 'Resize dialog', exact: true }),
	).toBeVisible()
	await expect(
		inspector.getByRole('heading', { name: 'Fixture delivery', exact: true }),
	).toBeVisible()
	await expect(inspector.locator('.message-identity-meta')).toContainText('received-001')
	await expect(inspector.getByRole('button', { name: 'Save message', exact: true })).toBeEnabled()
	await inspector.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(inspector.getByTestId('message-body')).toContainText('00 ff 41')
	await inspector.getByRole('button', { name: 'Close', exact: true }).click()
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await page.getByRole('button', { name: 'Receive & delete result', exact: true }).click()
	await expect(result()).toContainText('received-001')
	await dialog().getByRole('button', { name: 'Prepare another receive' }).click()
	await expect(run).toBeDisabled()
})
test('right-click targets the exact DLQ and retains that source on reopen', async () => {
	await page.getByRole('button', { name: 'Expand queue orders', exact: true }).click()
	await open('orders Transfer dead-letter')
	await expect(dialog().locator('.write-destination')).toContainText('Transfer dead-letter')
	await expect(dialog().getByLabel('Receive-and-delete session ID')).toHaveCount(0)
	await confirm()
	await dialog()
		.getByRole('button', { name: 'Receive & delete permanently', exact: true })
		.click()
	await expect(result()).toContainText('transfer-001')
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await open('orders Dead-letter')
	await expect(dialog().locator('.write-destination')).toContainText('Transfer dead-letter')
	await dialog().getByRole('button', { name: 'Prepare another receive' }).click()
	await expect(dialog().locator('.write-destination')).toContainText('Dead-letter')
	await expect(dialog().locator('.write-destination')).not.toContainText('Transfer')
	await confirm()
	await dialog()
		.getByRole('button', { name: 'Receive & delete permanently', exact: true })
		.click()
	await expect(result()).toContainText('dead-receive-001')
})
test('cancellation stops the receive and retains an uncertain result requiring review', async () => {
	await open('slow Active')
	await confirm()
	await dialog()
		.getByRole('button', { name: 'Receive & delete permanently', exact: true })
		.click()
	await expect(
		dialog().getByRole('button', { name: 'Cancel receive & delete', exact: true }),
	).toBeVisible()
	await expect(dialog().getByRole('status')).toContainText('1 seconds', { timeout: 3000 })
	await page.keyboard.press('Escape')
	await expect(dialog()).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel receive & delete', exact: true }).click()
	await expect(result()).toContainText('Cancelled.')
	await expect(result()).toContainText('The total consumed is unknown')
	await expect(dialog().getByRole('button', { name: 'Prepare another receive' })).toBeDisabled()
	await screenshot('receive-delete-cancelled')
	await dialog()
		.getByRole('checkbox', { name: /I have reviewed/ })
		.check()
	await expect(dialog().getByRole('button', { name: 'Prepare another receive' })).toBeEnabled()
})
test('time limit ends a slow receive and retains partial/unknown outcome', async () => {
	await open('slow Active')
	await dialog().getByLabel('Receive-and-delete time limit').fill('1')
	await confirm()
	await dialog()
		.getByRole('button', { name: 'Receive & delete permanently', exact: true })
		.click()
	await expect(result()).toContainText('Time limit reached.')
	await expect(result()).toContainText('unknown')
})
test('session-specific confirmation and current receiver guards are visible', async () => {
	await open('sessions Sessions Active')
	await dialog().getByLabel('Receive-and-delete session ID').fill('session-001')
	await expect(dialog().getByLabel('Receive-and-delete session ID')).toHaveValue('session-001')
	await expect(dialog().getByLabel('Receive-and-delete confirmation')).toHaveCount(0)
	await confirm()
	await dialog()
		.getByRole('button', { name: 'Receive & delete permanently', exact: true })
		.click()
	await expect(result()).toContainText('1 message returned and permanently consumed.')
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Close receiver', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Receive & delete…', exact: true }).click()
	await dialog().getByRole('button', { name: 'Prepare another receive' }).click()
	await expect(dialog()).toContainText(
		'Stop the listener and close the current message or session receiver first.',
	)
	await confirm()
	await expect(
		dialog().getByRole('button', { name: 'Receive & delete permanently', exact: true }),
	).toBeDisabled()
})
