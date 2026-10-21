import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
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
	await page.locator('.entity-admin > summary').click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function dismissMessage() {
	const inspector = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	if (await inspector.count()) {
		await page.keyboard.press('Escape')
		await expect(inspector).toHaveCount(0)
	}
}
async function select(name: string) {
	await dismissMessage()
	await page
		.getByRole('complementary', { name: 'Entities', exact: true })
		.getByRole('button', { name, exact: true })
		.click()
	await expect(page.getByText('Inspect entity…', { exact: false })).not.toBeVisible()
}
async function peek() {
	await dismissMessage()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
}

async function seed(
	id: string,
	queue = 'empty',
	body = '{"n":9007199254740993,"value":"<script>alert(1)</script>","enabled":true,"optional":null}',
) {
	await select(`${queue} Active`)
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Message ID', { exact: true }).fill(id)
	await dialog.getByLabel('Message body', { exact: true }).fill(body)

	await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(dialog).toHaveCount(0)
}
async function inspect(id: string) {
	await peek()
	await page
		.locator('.message-table')
		.getByRole('button', { name: new RegExp(id) })
		.click()
	return page.getByRole('dialog', { name: 'Inspect message', exact: true })
}
test('resends the exact inspected copy with colored JSON and keeps its source', async () => {
	await seed('inspect-original')
	const dialog = await inspect('inspect-original')
	await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
	await expect(dialog.locator('.json-key').first()).toHaveText('"n"')
	await expect(dialog.locator('.json-number')).toHaveText('9007199254740993')
	await expect(dialog.locator('.json-string')).toHaveText('"<script>alert(1)</script>"')
	await expect(dialog.locator('.json-boolean')).toHaveText('true')
	await expect(dialog.locator('.json-null')).toHaveText('null')
	expect(await dialog.locator('script').count()).toBe(0)
	expect(
		await dialog
			.locator('.json-key')
			.first()
			.evaluate((element) => getComputedStyle(element).color),
	).not.toBe(
		await dialog.locator('.json-string').evaluate((element) => getComputedStyle(element).color),
	)
	await page.screenshot({ path: 'test-results/inspector-json-colors.png' })
	await dialog.getByRole('button', { name: 'Resend message', exact: true }).click()
	await dialog.getByLabel('Inspected message destination', { exact: true }).fill('orders')
	await dialog.getByLabel('Resent message ID', { exact: true }).fill('inspect-copy')
	await expect(
		dialog.getByRole('button', { name: 'Confirm resend message', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed the destination and message ID policy.',
			exact: true,
		})
		.check()
	await page.screenshot({ path: 'test-results/inspector-colored-resend.png' })
	await dialog.getByRole('button', { name: 'Confirm resend message', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('The source was kept')
	await dismissMessage()
	await peek()
	await expect(page.locator('.message-table')).toContainText('inspect-original')
	await select('orders Active')
	await peek()
	await expect(page.locator('.message-table')).toContainText('inspect-copy')
})
test('receives from the inspector then deletes only the matched message with a checkbox', async () => {
	await seed('inspected-delete')
	await seed('keep-other')
	const dialog = await inspect('inspected-delete')
	await dialog.getByRole('button', { name: 'Delete message', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Confirm delete message', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('button', { name: 'Receive and lock for this message', exact: true })
		.click()
	await expect(dialog.getByRole('checkbox', { name: /I understand this message/ })).toBeEnabled()
	await dialog.getByRole('checkbox', { name: /I understand this message/ }).check()
	await dialog.getByRole('button', { name: 'Confirm delete message', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('Broker acknowledged complete')
	await dismissMessage()
	await peek()
	await expect(page.locator('.message-table')).not.toContainText('inspected-delete')
	await expect(page.locator('.message-table')).toContainText('keep-other')
	await expect(
		page.getByRole('article', { name: 'Received keep-other', exact: true }),
	).toContainText('active')
})
test('does not delete a different received message when the peeked snapshot is absent', async () => {
	await select('orders Active') // fixture peek-only snapshot differs from its received seed
	const dialog = await inspect('order-001')
	await dialog.getByRole('button', { name: 'Delete message', exact: true }).click()
	await dialog
		.getByRole('button', { name: 'Receive and lock for this message', exact: true })
		.click()
	await expect(dialog.getByText('This message was not available', { exact: false })).toBeVisible()
	await expect(
		dialog.getByRole('button', { name: 'Confirm delete message', exact: true }),
	).toBeDisabled()
	await expect(dialog.getByRole('checkbox', { name: /I understand this message/ })).toBeDisabled()
	await dismissMessage()
	await expect(
		page.getByRole('article', { name: 'Received received-001', exact: true }),
	).toContainText('active')
	await expect(
		page.getByRole('article', { name: 'Received received-002', exact: true }),
	).toContainText('active')
})
test('inspector unknown resend stays visible and cannot be resubmitted', async () => {
	await seed('unknown-source')
	const dialog = await inspect('unknown-source')
	await dialog.getByRole('button', { name: 'Resend message', exact: true }).click()
	await dialog.getByLabel('Resent message ID', { exact: true }).fill('unknown-send')
	await dialog.getByRole('checkbox', { name: /I reviewed the destination/ }).check()
	await dialog.getByRole('button', { name: 'Confirm resend message', exact: true }).click()
	await expect(dialog.locator('.operation-outcome')).toContainText('unknown')
	await expect(dialog.getByRole('button', { name: 'Resend message', exact: true })).toBeDisabled()
	await expect(
		dialog.getByRole('button', { name: 'Confirm resend message', exact: true }),
	).toHaveCount(0)
})
test('refreshes a clicked topic or subscription without changing the current selection', async () => {
	await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
	await select('orders Active')
	for (const name of ['order-events Active', 'billing Active']) {
		await page.getByRole('button', { name, exact: true }).click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Refresh status', exact: true }).click()
		await expect(page.getByRole('button', { name, exact: true })).toBeEnabled()
		await expect(page.getByRole('heading', { name: 'orders', exact: true })).toBeVisible()
	}
	await select('billing Active')
	await page
		.getByRole('button', { name: 'billing Active', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Refresh status', exact: true }).click()
	await expect(page.getByRole('heading', { name: 'billing', exact: true })).toBeVisible()
})
test('resends an inspected dead letter and removes only the locked original transactionally', async () => {
	await seed('inspected-dlq')
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	await page
		.getByRole('article', { name: 'Received inspected-dlq', exact: true })
		.getByRole('button', { name: 'Dead-letter received', exact: true })
		.click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Confirm dead-letter', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Close receiver', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Close and let locks expire', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	const dialog = await inspect('inspected-dlq')
	await dialog.getByRole('button', { name: 'Resend message', exact: true }).click()
	await dialog.getByLabel('Resent message ID', { exact: true }).fill('dlq-copy')
	await dialog.getByRole('checkbox', { name: /Remove the original after resending/ }).check()
	await expect(
		dialog.getByRole('button', { name: 'Confirm resend message', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('button', { name: 'Receive and lock for this message', exact: true })
		.click()
	await dialog.getByRole('checkbox', { name: /I reviewed the destination/ }).check()
	await dialog.getByRole('button', { name: 'Confirm resend message', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('Replay transaction committed')
	await dismissMessage()
	await peek()
	await expect(page.locator('.message-table')).not.toContainText('inspected-dlq')
	await page.getByRole('button', { name: 'Main queue', exact: true }).click()
	await peek()
	await expect(page.locator('.message-table')).toContainText('dlq-copy')
})
test('deletes directly from a received-message inspector', async () => {
	await seed('received-inspector')
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	const held = page.getByRole('article', { name: 'Received received-inspector', exact: true })
	await held.getByRole('button', { name: 'Inspect received', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Received message', exact: true })
	await dialog.getByRole('button', { name: 'Delete message', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Receive and lock for this message', exact: true }),
	).toHaveCount(0)
	await dialog.getByRole('checkbox', { name: /I understand this message/ }).check()
	await dialog.getByRole('button', { name: 'Confirm delete message', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('Broker acknowledged complete')
	await page.keyboard.press('Escape')
	await expect(held).toContainText('completed')
})
test('cancels the inspected scheduled sequence and retains its receipt in the modal', async () => {
	await select('empty Active')
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const composer = page.getByRole('dialog')
	await composer.getByLabel('Message ID', { exact: true }).fill('inspected-scheduled')
	await composer.getByLabel('Message body', { exact: true }).fill('{"later":true}')
	await composer.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await composer.getByLabel('Schedule for later', { exact: true }).check()
	await composer
		.getByLabel('Scheduled enqueue time', { exact: true })
		.fill(new Date(Date.now() + 3600000).toISOString())
	await composer.getByRole('button', { name: 'Schedule batch', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await page.getByRole('button', { name: 'Scheduled messages', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Refresh scheduled messages', exact: true }).click()
	await dialog.getByRole('button', { name: 'Inspect scheduled', exact: true }).click()
	await expect(dialog.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await expect(dialog.getByRole('button', { name: 'Move dialog', exact: true })).toBeVisible()
	await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	expect(
		await dialog.locator('.json-key').evaluate((element) => getComputedStyle(element).color),
	).toBe('rgb(125, 211, 252)')
	expect(
		await dialog.locator('.json-body').evaluate((element) => getComputedStyle(element).color),
	).toBe('rgb(238, 233, 224)')
	await dialog.locator('.json-body').screenshot({ path: 'test-results/inspector-dark-json.png' })
	const actions = dialog.getByRole('region', { name: 'Inspected message actions', exact: true })
	await actions.getByRole('button', { name: 'Delete message', exact: true }).click()
	await expect(actions).toContainText('Cancel this scheduled message')
	await expect(
		actions.getByRole('button', { name: 'Receive and lock for this message', exact: true }),
	).toHaveCount(0)
	await actions.getByRole('checkbox', { name: /I understand this message/ }).check()
	await actions.getByRole('button', { name: 'Confirm delete message', exact: true }).click()
	await expect(actions.getByRole('status')).toContainText(
		'Broker acknowledged cancellation for 1 scheduled sequence',
	)
	await dialog.getByRole('button', { name: 'Refresh scheduled messages', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Inspect scheduled', exact: true }),
	).toHaveCount(0)
})
