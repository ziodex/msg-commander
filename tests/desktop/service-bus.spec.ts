import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
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

test('browses paginated entities, inspects exact JSON and binary messages, and switches to dead letters', async () => {
	await page.getByRole('button', { name: 'Load more queues', exact: true }).click()
	await expect(page.getByRole('button', { name: 'archive Active', exact: true })).toBeVisible()
	await select('orders Active')
	await page.getByLabel('Page size', { exact: true }).fill('1')
	await peek()
	await page.getByRole('button', { name: '9007199254740993 order-001', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('Málaga 🚀')
	await expect(page.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await page.getByRole('button', { name: 'TEXT', exact: true }).click()
	await expect(page.getByRole('button', { name: 'TEXT', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await page.getByRole('button', { name: 'JSON', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('9007199254740993')
	await expect(page.getByTestId('message-body')).toContainText('<script>alert(1)</script>')
	await expect(
		page.getByRole('cell', { name: '18446744073709551615', exact: true }),
	).toBeVisible()
	expect(await page.locator('script').count()).toBe(1)
	await page.screenshot({ path: 'test-results/service-bus-inspector.png' })
	await dismissMessage()
	await page.getByRole('button', { name: 'Peek next', exact: true }).click()
	await page.getByRole('button', { name: '9007199254740996 binary-002', exact: true }).click()
	await expect(page.getByRole('button', { name: 'TEXT', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await expect(page.getByRole('button', { name: 'JSON', exact: true })).toBeDisabled()
	await expect(page.getByText('This range is not valid UTF-8.', { exact: false })).toBeVisible()
	await page.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('00 ff 80 41')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await peek()
	await page.getByRole('button', { name: '9007199254740993 dead-order', exact: true }).click()
	await expect(page.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await expect(page.getByText('ValidationFailed', { exact: false }).first()).toBeVisible()
	await expect(page.getByText('Missing customer ID', { exact: false }).first()).toBeVisible()
})
test('message inspector moves and resizes with pointer and keyboard and stays inside the window', async () => {
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 960),
	)
	await select('orders Active')
	await peek()
	const messageButton = page.getByRole('button', {
		name: '9007199254740993 order-001',
		exact: true,
	})
	await messageButton.click()
	const dialog = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(dialog.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	const initial = (await dialog.boundingBox())!
	const corner = (await dialog
		.getByRole('button', { name: 'Resize dialog', exact: true })
		.boundingBox())!
	await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
	await page.mouse.down()
	await page.mouse.move(corner.x + corner.width / 2 - 180, corner.y + corner.height / 2 - 140, {
		steps: 8,
	})
	await page.mouse.up()
	await expect
		.poll(async () => (await dialog.boundingBox())!.width)
		.toBeCloseTo(initial.width - 180, 0)
	await expect
		.poll(async () => (await dialog.boundingBox())!.height)
		.toBeCloseTo(initial.height - 140, 0)
	const title = (await dialog
		.getByRole('heading', { name: 'Inspect message', exact: true })
		.boundingBox())!
	await page.mouse.move(title.x + 50, title.y + title.height / 2)
	await page.mouse.down()
	await page.mouse.move(title.x + 110, title.y + title.height / 2 + 35, { steps: 8 })
	await page.mouse.up()
	await expect.poll(async () => (await dialog.boundingBox())!.x).toBeCloseTo(initial.x + 60, 0)
	await expect.poll(async () => (await dialog.boundingBox())!.y).toBeCloseTo(initial.y + 35, 0)
	await dialog.getByRole('button', { name: 'Move dialog', exact: true }).focus()
	await page.keyboard.press('ArrowLeft')
	await expect.poll(async () => (await dialog.boundingBox())!.x).toBeCloseTo(initial.x + 50, 0)
	await dialog.getByRole('button', { name: 'Resize dialog', exact: true }).focus()
	await page.keyboard.press('Shift+ArrowRight')
	await expect
		.poll(async () => (await dialog.boundingBox())!.width)
		.toBeCloseTo(initial.width - 140, 0)
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]!.setContentSize(960, 680),
	)
	await expect
		.poll(async () => {
			const rect = (await dialog.boundingBox())!
			return (
				rect.x >= 10 &&
				rect.y >= 10 &&
				rect.x + rect.width <= 950 &&
				rect.y + rect.height <= 670
			)
		})
		.toBe(true)
	await expect(
		dialog.getByRole('button', { name: 'Resize dialog', exact: true }),
	).toBeInViewport()
	await expect(dialog.getByTestId('message-body')).toContainText('9007199254740993')
	await page.screenshot({ path: 'artifacts/movable-message-inspector.png' })
	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
	await expect(messageButton).toBeFocused()
})

test('browses topic subscriptions, peeks session entities, and clears handles on reload', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toHaveCount(0)
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await select('audit Sessions Active')
	await peek()
	await expect(page.getByText('Session: session-001', { exact: true })).toBeVisible()
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await peek()
	await expect(
		page.getByRole('button', { name: '9007199254740993 dead-order', exact: true }),
	).toBeVisible()
	await page.reload()
	await expect(page.getByRole('region', { name: 'Service Bus workspace' })).toHaveCount(0)
	await page
		.getByRole('button', {
			name: 'Offline namespace fixture.servicebus.windows.net',
			exact: true,
		})
		.click()
	await expect(page.getByRole('button', { name: 'Connect and browse' })).toBeVisible()
	await page.getByRole('button', { name: 'Connect and browse' }).click()
	await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Connect and browse' })).toBeVisible()
})
test('cancels a pending peek, shows permission errors, and pages through a large body', async () => {
	await select('slow Active')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
	await select('denied Active')
	await peek()
	await expect(page.getByRole('alert')).toContainText('Listen rights')
	await expect(page.getByRole('alert')).not.toContainText('SECRET')
	await select('large Active')
	await peek()
	await page.getByRole('button', { name: '1 large', exact: true }).click()
	await expect(page.getByText('Bytes 0–65536 of 300000', { exact: true })).toBeVisible()
	for (let i = 0; i < 3; i++) {
		await page.getByRole('button', { name: 'Load more bytes', exact: true }).click()
		await expect(
			page.getByText('Bytes 0–' + (i + 2) * 65536 + ' of 300000', { exact: true }),
		).toBeVisible()
	}
	await page.getByRole('button', { name: 'Next body range', exact: true }).click()
	await expect(page.getByText('Bytes 262144–300000 of 300000', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('00040000')
	await page.getByRole('button', { name: 'Previous body range', exact: true }).click()
	await expect(page.getByText('Bytes 0–65536 of 300000', { exact: true })).toBeVisible()
})

async function compose(id: string, body: string) {
	await dismissMessage()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Message ID', { exact: true }).fill(id)
	await dialog.getByLabel('Message body', { exact: true }).fill(body)
	return dialog
}
async function receive() {
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Refresh held messages', exact: true }),
	).toBeEnabled()
}
async function confirmAction(name: string) {
	await page.getByRole('dialog').getByRole('button', { name, exact: true }).click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('composes exact JSON with typed properties and confirms completion of an owned message', async () => {
	await select('orders Active')
	const dialog = await compose('ui-send-001', '{"large":9007199254740993,"city":"Málaga 🚀"}')
	await dialog.getByRole('button', { name: 'Add property', exact: true }).click()
	await dialog.getByLabel('Property name 1', { exact: true }).fill('exact')
	await dialog.getByLabel('Property type 1', { exact: true }).selectOption('int64')
	await dialog.getByLabel('Property value 1', { exact: true }).fill('9223372036854775807')
	await page.screenshot({ path: 'test-results/message-composer.png' })
	await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(page.locator('.operation-outcome')).toContainText('CONFIRMED')
	await receive()
	const item = page.getByRole('article', { name: 'Received ui-send-001', exact: true })
	await expect(item).toContainText('active')
	await expect(page.getByRole('button', { name: 'Receive and lock', exact: true })).toBeDisabled()
	await item.getByRole('button', { name: 'Inspect received', exact: true }).click()
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'JSON', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'Move dialog', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('dialog').getByTestId('message-body')).toContainText(
		'9007199254740993',
	)
	await expect(
		page.getByRole('dialog').getByRole('cell', { name: '9223372036854775807', exact: true }),
	).toBeVisible()
	await page.keyboard.press('Escape')
	await item.getByRole('button', { name: 'Complete', exact: true }).click()
	await page.getByRole('button', { name: 'Cancel action', exact: true }).click()
	await expect(item.getByRole('button', { name: 'Complete', exact: true })).toBeEnabled()
	await item.getByRole('button', { name: 'Complete', exact: true }).click()
	await confirmAction('Confirm complete')
	await expect(item).toContainText('completed')
	await peek()
	await expect(
		page.getByText('No messages returned at this sequence.', { exact: false }),
	).toBeVisible()
})

test('sends to a topic, abandons and dead-letters a subscription delivery, then replays to a queue', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	const composer = await compose('topic-ui', '{"order":42}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await select('billing Active')
	await receive()
	let item = page.getByRole('article', { name: 'Received topic-ui', exact: true })
	await item.getByRole('button', { name: 'Abandon', exact: true }).click()
	await confirmAction('Confirm abandon')
	await expect(item).toContainText('abandoned')
	await receive()
	await item.getByRole('button', { name: 'Dead-letter received', exact: true }).click()
	await page.getByLabel('Dead-letter reason', { exact: true }).fill('ReviewOrder')
	await confirmAction('Confirm dead-letter')
	await expect(item).toContainText('dead-lettered')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await receive()
	await item.getByRole('button', { name: 'Replay dead-letter', exact: true }).click()
	const replay = page.getByRole('dialog')
	await expect(replay.getByLabel('Replay destination type', { exact: true })).toHaveValue('topic')
	await expect(
		replay.getByText('A topic replay reaches every matching subscription', { exact: false }),
	).toBeVisible()
	await replay.getByLabel('Replay message ID policy', { exact: true }).selectOption('preserve')
	await expect(
		replay.getByText('Duplicate detection may discard', { exact: false }),
	).toBeVisible()
	await replay.getByLabel('Replay message ID policy', { exact: true }).selectOption('new')
	await replay.getByLabel('Replay destination type', { exact: true }).selectOption('queue')
	await replay.getByLabel('Replay destination name', { exact: true }).fill('orders')
	await replay.getByLabel('Replay message ID', { exact: true }).fill('replayed-ui')
	await page.screenshot({ path: 'test-results/replay-confirmation.png' })
	await confirmAction('Replay and complete source')
	await expect(item).toContainText('replayed')
	await dismissMessage()
	await page.getByRole('button', { name: 'Queues', exact: true }).click()
	await select('orders Active')
	await receive()
	item = page.getByRole('article', { name: 'Received replayed-ui', exact: true })
	await item.getByRole('button', { name: 'Inspect received', exact: true }).click()
	await expect
		.poll(async () =>
			JSON.parse((await page.getByRole('dialog').getByTestId('message-body').textContent())!),
		)
		.toEqual({ order: 42 })
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: /Switch to .* theme/ }).click()
	await page.screenshot({ path: 'test-results/received-message-dark.png', fullPage: true })
})

test('retrieves a deferred session message, renews the session lock and recovers from cancelled receive', async () => {
	await select('sessions Sessions Active')
	await expect(page.getByRole('button', { name: 'Receive and lock', exact: true })).toBeDisabled()
	await page.getByLabel('Receive session ID', { exact: true }).fill('session-001')
	await receive()
	const item = page.getByRole('article', { name: 'Received received-001', exact: true })
	const sequence = (await item
		.locator('.message-identity-meta > span')
		.last()
		.textContent())!.slice(1)
	await item.getByRole('button', { name: 'Defer', exact: true }).click()
	await confirmAction('Confirm defer')
	await expect(item).toContainText('deferred')
	const references = page.locator('.deferred-references')
	await expect(references.getByLabel('Recorded deferred sequence')).toHaveValue(sequence)
	await page.getByLabel('Receive session ID', { exact: true }).fill('another-session')
	await expect(references).toContainText('Deferred references · 0')
	await page.getByLabel('Receive session ID', { exact: true }).fill('session-001')
	await expect(references.getByLabel('Recorded deferred sequence')).toHaveValue(sequence)
	await references.getByRole('button', { name: 'Use sequence', exact: true }).click()
	await receive()
	await item.getByRole('button', { name: 'Renew lock', exact: true }).click()
	await confirmAction('Confirm renew')
	await expect(page.locator('.operation-outcome')).toContainText('Broker acknowledged renew')
	await page.getByRole('button', { name: 'Close receiver', exact: true }).click()
	await confirmAction('Close and let locks expire')
	await expect(item).toHaveCount(0)
	await select('slow Active')
	await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
	await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Receive and lock', exact: true })).toBeEnabled()
	await expect(page.getByRole('alert')).toContainText('locks acquired before interruption')
})

test('recorded deferred sequences survive view refresh and are removed after confirmed retrieval', async () => {
	await select('orders Active')
	await receive()
	const item = page.getByRole('article', { name: 'Received received-001', exact: true })
	const sequence = (await item
		.locator('.message-identity-meta > span')
		.last()
		.textContent())!.slice(1)
	await item.getByRole('button', { name: 'Defer', exact: true }).click()
	await confirmAction('Confirm defer')
	const references = page.locator('.deferred-references')
	await expect(references.getByLabel('Recorded deferred sequence')).toHaveValue(sequence)
	await references.scrollIntoViewIfNeeded()
	await expect(item).not.toContainText('Lock expires')
	await page.screenshot({ path: 'artifacts/deferred-references-preview.png' })
	await page.getByRole('button', { name: 'Refresh held messages', exact: true }).click()
	await expect(references.getByLabel('Recorded deferred sequence')).toHaveValue(sequence)
	await references.getByRole('button', { name: 'Use sequence', exact: true }).click()
	await expect(page.getByLabel('Deferred sequence', { exact: true })).toHaveValue(sequence)
	await receive()
	await expect(item).toContainText('active')
	await expect(references).toContainText('Deferred references · 0')
})

test('forgetting a deferred reference leaves its message available for manual retrieval', async () => {
	await select('orders Active')
	await receive()
	const item = page.getByRole('article', { name: 'Received received-001', exact: true })
	const sequence = (await item
		.locator('.message-identity-meta > span')
		.last()
		.textContent())!.slice(1)
	await item.getByRole('button', { name: 'Defer', exact: true }).click()
	await confirmAction('Confirm defer')
	const references = page.locator('.deferred-references')
	await expect(references.getByLabel('Recorded deferred sequence')).toHaveValue(sequence)
	await references.getByRole('button', { name: 'Forget reference', exact: true }).click()
	await expect(references).toContainText('Deferred references · 0')
	await page.getByLabel('Deferred sequence', { exact: true }).fill(sequence)
	await receive()
	await expect(item).toContainText('active')
})

test('shows an uncertain send and blocks automatic or accidental repetition in the composer', async () => {
	await select('orders Active')
	const dialog = await compose('unknown-send', '{"one":1}')
	await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await dialog.getByRole('button', { name: 'Check outcome', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await expect(dialog.getByRole('status')).not.toContainText('SECRET')
	await page.keyboard.press('Escape')
	await peek()
	await expect(page.getByRole('button', { name: /9007199254741000 unknown-send/ })).toHaveCount(1)
})

test('creates and edits a queue, validates settings and requires exact confirmation before deletion', async () => {
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	let dialog = page.getByRole('dialog')
	await dialog.getByLabel('Entity name', { exact: true }).fill('managed-queue')
	await dialog.getByLabel('Default message TTL', { exact: true }).fill('1.00:00:00')
	await dialog.getByLabel('Require sessions', { exact: true }).check()
	await dialog.getByLabel('User metadata', { exact: true }).fill('Owner: Málaga 🚀')
	await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(page.getByRole('heading', { name: 'managed-queue', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Edit queue', exact: true }).click()
	dialog = page.getByRole('dialog')
	await expect(dialog.getByLabel('Entity name', { exact: true })).toHaveAttribute('readonly', '')
	await expect(dialog.getByLabel('Require sessions', { exact: true })).toBeChecked()
	await expect(dialog.getByLabel('Require sessions', { exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('User metadata', { exact: true })).toHaveValue(
		'Owner: Málaga 🚀',
	)
	await dialog.getByLabel('Lock duration', { exact: true }).fill('00:05:01')
	await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('rejected')
	await dialog.getByLabel('Lock duration', { exact: true }).fill('00:00:45')
	await dialog.getByLabel('Entity status', { exact: true }).selectOption('Disabled')
	await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'managed-queue Sessions Disabled', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Delete queue', exact: true }).click()
	await expect(
		page
			.getByRole('dialog')
			.getByRole('button', { name: 'Permanently delete queue', exact: true }),
	).toBeDisabled()
	await expect(
		page.getByRole('dialog').getByLabel('Confirm entity path', { exact: true }),
	).toHaveCount(0)
	await expect(
		page
			.getByRole('dialog')
			.getByRole('button', { name: 'Permanently delete queue', exact: true }),
	).toBeDisabled()
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(page.getByRole('heading', { name: 'managed-queue', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Delete queue', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('checkbox', {
			name: 'I understand this queue and all its messages will be permanently deleted.',
			exact: true,
		})
		.check()
	await page.screenshot({ path: 'test-results/delete-entity.png' })
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Permanently delete queue', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'managed-queue Sessions Disabled', exact: true }),
	).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
})

test('manages topics and subscriptions and makes topic cascade deletion explicit', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await page.getByRole('button', { name: 'Create topic', exact: true }).click()
	await page.getByRole('dialog').getByLabel('Entity name', { exact: true }).fill('managed-topic')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Create topic', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Edit topic', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByLabel('Maximum entity size (MiB)', { exact: true })
		.fill('2048')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Save changes', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Create subscription', exact: true }).click()
	await expect(page.getByRole('dialog').getByLabel('Parent topic', { exact: true })).toHaveValue(
		'managed-topic',
	)
	await expect(
		page.getByRole('dialog').getByText('match-all $Default rule', { exact: false }),
	).toBeVisible()
	await page.getByRole('dialog').getByLabel('Entity name', { exact: true }).fill('managed-sub')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Create subscription', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Edit subscription', exact: true }).click()
	await page.getByRole('dialog').getByLabel('Maximum delivery count', { exact: true }).fill('25')
	await page
		.getByRole('dialog')
		.getByLabel('User metadata', { exact: true })
		.fill('Edited subscription')
	await page.screenshot({ path: 'test-results/entity-editor.png' })
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Save changes', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await page.getByRole('button', { name: 'Delete subscription', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByLabel('Confirm entity path', { exact: true })
		.fill('managed-topic/Subscriptions/managed-sub')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Permanently delete subscription', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'managed-sub Active', exact: true })).toHaveCount(
		0,
	)
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('managed-topic Active')
	await page.getByRole('button', { name: 'Delete topic', exact: true }).click()
	await expect(
		page.getByRole('dialog').getByText('also deletes every subscription', { exact: false }),
	).toBeVisible()
	await page
		.getByRole('dialog')
		.getByLabel('Confirm entity path', { exact: true })
		.fill('managed-topic')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Permanently delete topic', exact: true })
		.click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'managed-topic Active', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'order-events Active', exact: true }),
	).toBeVisible()
})

test('blocks editing/deleting a held source and reports uncertain entity creates without retrying', async () => {
	await select('orders Active')
	await receive()
	await page.getByRole('button', { name: 'Delete queue', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('checkbox', {
			name: 'I understand this queue and all its messages will be permanently deleted.',
			exact: true,
		})
		.check()
	await expect(
		page.getByRole('dialog').getByText("Close this entity's receiver", { exact: false }),
	).toBeVisible()
	await expect(
		page
			.getByRole('dialog')
			.getByRole('button', { name: 'Permanently delete queue', exact: true }),
	).toBeDisabled()
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByLabel('Entity name', { exact: true })
		.fill('unknown-entity-ui')
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Create queue', exact: true })
		.click()
	await expect(page.getByRole('dialog').getByRole('status')).toContainText('unknown')
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'Create queue', exact: true }),
	).toBeDisabled()
	await expect(page.getByRole('dialog').getByLabel('Entity name', { exact: true })).toBeDisabled()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Check outcome', exact: true })
		.click()
	await expect(page.getByRole('dialog').getByRole('status')).toContainText('unknown')
	await expect(page.getByRole('dialog').getByRole('status')).not.toContainText('SECRET')
	await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
	await page.getByRole('button', { name: 'Refresh entities', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'unknown-entity-ui Active', exact: true }),
	).toHaveCount(1)
})

test('cancels a management request from its dialog and checks the uncertain receipt', async () => {
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Entity name', { exact: true }).fill('slow-entity')
	await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
	await dialog.getByRole('button', { name: 'Cancel operation', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await dialog.getByRole('button', { name: 'Check outcome', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
})

async function openRules() {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await select('billing Active')
	await page.getByRole('button', { name: 'Manage subscription rules', exact: true }).click()
	await expect(
		page.getByRole('dialog').getByRole('button', { name: 'Edit rule $Default', exact: true }),
	).toBeVisible()
	return page.getByRole('dialog')
}

test('manages SQL filters, typed parameters and actions without silently removing the default', async () => {
	const dialog = await openRules()
	await expect(
		dialog.getByText('Creating another rule does not remove it.', { exact: false }),
	).toBeVisible()
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByLabel('Rule name', { exact: true }).fill('priority')
	await dialog.getByLabel('SQL filter expression', { exact: true }).fill('user.total > @minimum')
	await dialog.getByRole('button', { name: 'Add filter parameters', exact: true }).click()
	await dialog.getByLabel('Filter parameters name 1', { exact: true }).fill('@minimum')
	await dialog.getByLabel('Filter parameters type 1', { exact: true }).selectOption('int64')
	await dialog.getByLabel('Filter parameters value 1', { exact: true }).fill('9007199254740993')
	await dialog
		.getByLabel('SQL rule action', { exact: true })
		.fill('SET user.route = @route; REMOVE user.secret;')
	await dialog.getByRole('button', { name: 'Add action parameters', exact: true }).click()
	await dialog.getByLabel('Action parameters name 1', { exact: true }).fill('@route')
	await dialog.getByLabel('Action parameters value 1', { exact: true }).fill('Málaga 🚀')
	await page.screenshot({ path: 'test-results/sql-rule-editor.png' })
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule priority', exact: true }),
	).toBeVisible()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule $Default', exact: true }),
	).toBeVisible()
	await dialog.getByRole('button', { name: 'Edit rule priority', exact: true }).click()
	await expect(dialog.getByLabel('Rule name', { exact: true })).toHaveAttribute('readonly', '')
	await expect(dialog.getByLabel('Filter parameters value 1', { exact: true })).toHaveValue(
		'9007199254740993',
	)
	await expect(dialog.getByLabel('Action parameters value 1', { exact: true })).toHaveValue(
		'Málaga 🚀',
	)
	await dialog.getByLabel('SQL rule action', { exact: true }).fill('')
	await dialog.getByRole('button', { name: 'Remove action parameters 1', exact: true }).click()
	await dialog.getByRole('button', { name: 'Save rule', exact: true }).click()
	await expect(
		dialog
			.getByRole('row')
			.filter({ has: page.getByRole('cell', { name: 'priority', exact: true }) }),
	).toContainText('None')
	await dialog.getByRole('button', { name: 'Delete rule priority', exact: true }).click()
	await expect(dialog.getByLabel('Confirm rule path', { exact: true })).toHaveCount(0)
	await expect(
		dialog.getByRole('button', { name: 'Permanently delete rule', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand this rule will be permanently deleted.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Permanently delete rule', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule priority', exact: true }),
	).toHaveCount(0)
	await expect(
		dialog.getByRole('button', { name: 'Edit rule $Default', exact: true }),
	).toBeVisible()
})

test('edits correlation matches, pages through rules and explicitly deletes the default', async () => {
	const dialog = await openRules()
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByLabel('Rule name', { exact: true }).fill('correlated')
	await dialog.getByLabel('Rule filter type', { exact: true }).selectOption('correlation')
	await dialog.getByLabel('Match Correlation ID', { exact: true }).fill('order-001')
	await dialog.getByLabel('Match Subject', { exact: true }).fill('Blue')
	await dialog.getByRole('button', { name: 'Add correlation properties', exact: true }).click()
	await dialog.getByLabel('Correlation properties name 1', { exact: true }).fill('enabled')
	await dialog
		.getByLabel('Correlation properties type 1', { exact: true })
		.selectOption('boolean')
	await dialog.getByLabel('Correlation properties value 1', { exact: true }).fill('true')
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByRole('button', { name: 'Edit rule correlated', exact: true }).click()
	await expect(dialog.getByLabel('Match Subject', { exact: true })).toHaveValue('Blue')
	await expect(dialog.getByLabel('Correlation properties type 1', { exact: true })).toHaveValue(
		'boolean',
	)
	await dialog.getByLabel('Match Subject', { exact: true }).fill('Red')
	await dialog.getByLabel('SQL rule action', { exact: true }).fill("SET user.route = 'red';")
	await page.screenshot({ path: 'test-results/correlation-rule-editor.png' })
	await dialog.getByRole('button', { name: 'Save rule', exact: true }).click()
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByLabel('Rule name', { exact: true }).fill('none')
	await dialog.getByLabel('Rule filter type', { exact: true }).selectOption('false')
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByRole('button', { name: 'Next rules', exact: true }).click()
	await expect(dialog.getByRole('button', { name: 'Edit rule none', exact: true })).toBeVisible()
	await dialog.getByRole('button', { name: 'Previous rules', exact: true }).click()
	await dialog.getByRole('button', { name: 'Edit rule $Default', exact: true }).click()
	await expect(dialog.getByLabel('Rule filter type', { exact: true })).toHaveValue('true')
	await dialog.getByRole('button', { name: 'Back to rules', exact: true }).click()
	await dialog.getByRole('button', { name: 'Delete rule $Default', exact: true }).click()
	await expect(
		dialog.getByText('Stored messages and other rules are not deleted.', { exact: false }),
	).toBeVisible()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand this rule will be permanently deleted.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Permanently delete rule', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule $Default', exact: true }),
	).toHaveCount(0)
	await expect(
		dialog.getByRole('button', { name: 'Edit rule correlated', exact: true }),
	).toBeVisible()
	await dialog.getByRole('button', { name: 'Close rules', exact: true }).click()
	await page.getByRole('button', { name: 'Manage subscription rules', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule $Default', exact: true }),
	).toHaveCount(0)
})

test('shows broker rule rejections and uncertain cancellations without automatic resubmission', async () => {
	const dialog = await openRules()
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByLabel('Rule name', { exact: true }).fill('test-rule')
	await dialog.getByLabel('SQL filter expression', { exact: true }).fill('INVALID SQL')
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('SQL filter/action syntax')
	await expect(dialog.getByRole('status')).not.toContainText('SECRET')
	await dialog.getByLabel('SQL filter expression', { exact: true }).fill("user.color = 'blue'")
	await dialog.getByLabel('Rule name', { exact: true }).fill('slow-rule')
	await dialog.getByRole('button', { name: 'Create rule', exact: true }).click()
	await dialog.getByRole('button', { name: 'Cancel operation', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await expect(dialog.getByRole('button', { name: 'Create rule', exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('Rule name', { exact: true })).toBeDisabled()
	await dialog.getByRole('button', { name: 'Check outcome', exact: true }).click()
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await dialog.getByRole('button', { name: 'Back to rules', exact: true }).click()
	await dialog.getByRole('button', { name: 'Refresh rules', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Edit rule slow-rule', exact: true }),
	).toHaveCount(0)
	await page.reload()
	await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('builds and edits an immediate batch, preserving distinct JSON and binary drafts', async () => {
	await select('orders Active')
	const dialog = await compose('batch-json', '{"exact":9007199254740993}')
	await dialog.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await dialog.getByLabel('Message ID', { exact: true }).fill('batch-binary')
	await dialog.getByLabel('Body encoding', { exact: true }).selectOption('base64')
	await dialog.getByLabel('Message body', { exact: true }).fill('AP9B')
	await dialog.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await dialog.getByLabel('Edit batch message 1', { exact: true }).click()
	await expect(dialog.getByLabel('Message ID', { exact: true })).toHaveValue('batch-json')
	await dialog.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await page.screenshot({ path: 'test-results/batch-composer.png' })
	await dialog.getByRole('button', { name: 'Send batch', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(page.locator('.operation-outcome')).toContainText('2 message(s) sent')
	await peek()
	await page.getByRole('button', { name: /9007199254741000 batch-binary/ }).click()
	await page.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('00 ff 41')
	await dismissMessage()
	await page.getByRole('button', { name: /9007199254741001 batch-json/ }).click()
	await page.getByRole('button', { name: 'JSON', exact: true }).click()
	await expect(page.getByTestId('message-body')).toContainText('9007199254740993')
})

test('schedules a queue batch, inspects it and cancels exact sequences with destination confirmation', async () => {
	await select('orders Active')
	const composer = await compose('later-one', '{"exact":9007199254740993}')
	await composer.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await composer.getByLabel('Message ID', { exact: true }).fill('later-two')
	await composer.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await composer.getByLabel('Schedule for later', { exact: true }).check()
	await composer
		.getByLabel('Scheduled enqueue time', { exact: true })
		.fill('2020-01-01T00:00:00Z')
	await composer.getByRole('button', { name: 'Schedule batch', exact: true }).click()
	await expect(composer.getByRole('alert')).toContainText('must be in the future')
	await composer
		.getByLabel('Scheduled enqueue time', { exact: true })
		.fill(new Date(Date.now() + 3600000).toISOString())
	await page.screenshot({ path: 'test-results/scheduled-composer.png' })
	await composer.getByRole('button', { name: 'Schedule batch', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await expect(page.locator('.operation-outcome')).toContainText(
		'9007199254741000, 9007199254741001',
	)
	await page.getByRole('button', { name: 'Scheduled messages', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Refresh scheduled messages', exact: true }).click()
	const first = dialog.getByRole('article', { name: 'Scheduled later-one', exact: true })
	await first.getByRole('button', { name: 'Inspect scheduled', exact: true }).click()
	await expect(dialog.getByTestId('message-body')).toContainText('9007199254740993')
	await first.getByRole('button', { name: 'Choose for cancellation', exact: true }).click()
	await expect(dialog.getByLabel('Scheduled sequence numbers', { exact: true })).toHaveValue(
		'9007199254741000',
	)
	await expect(
		dialog.getByRole('button', { name: 'Cancel scheduled messages', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand these scheduled messages will be permanently cancelled.',
			exact: true,
		})
		.check()
	await dialog.evaluate((element) => {
		element.scrollTop = 0
	})
	await page.screenshot({ path: 'test-results/scheduled-browser.png' })
	await dialog.getByRole('button', { name: 'Cancel scheduled messages', exact: true }).click()
	await expect(first).toHaveCount(0)
	await expect(
		dialog.getByRole('article', { name: 'Scheduled later-two', exact: true }),
	).toBeVisible()
	await dialog.getByLabel('Scheduled sequence numbers', { exact: true }).fill('9007199254741001')
	await dialog
		.getByRole('checkbox', {
			name: 'I understand these scheduled messages will be permanently cancelled.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Cancel scheduled messages', exact: true }).click()
	await expect(dialog.getByRole('article')).toHaveCount(0)
	await expect(
		dialog.getByText('No scheduled messages found in this scan.', { exact: true }),
	).toBeVisible()
})

test('schedules and cancels a topic message directly on its topic', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	const composer = await compose('topic-scheduled', '{"topic":true}')
	await composer.getByLabel('Schedule for later', { exact: true }).check()
	await composer.getByRole('button', { name: 'Schedule message', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await page.getByRole('button', { name: 'Scheduled messages', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Refresh scheduled messages', exact: true }).click()
	await expect(dialog.getByRole('article')).toContainText('topic-scheduled')
	await dialog.getByRole('button', { name: 'Choose for cancellation', exact: true }).click()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand these scheduled messages will be permanently cancelled.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Cancel scheduled messages', exact: true }).click()
	await expect(dialog.getByRole('article')).toHaveCount(0)
	await expect(dialog.locator('.operation-outcome')).toContainText(
		'Broker acknowledged cancellation',
	)
})

test('blocks an uncertain scheduled send and recovers its broker snapshot without resending', async () => {
	await select('orders Active')
	const composer = await compose('unknown-batch', '{"uncertain":true}')
	await composer.getByLabel('Schedule for later', { exact: true }).check()
	await composer.getByRole('button', { name: 'Schedule message', exact: true }).click()
	await expect(composer.getByRole('status')).toContainText('unknown')
	await expect(
		composer.getByRole('button', { name: 'Schedule message', exact: true }),
	).toBeDisabled()
	await expect(composer.getByLabel('Message ID', { exact: true })).toBeDisabled()
	await composer.getByRole('button', { name: 'Check outcome', exact: true }).click()
	await expect(composer.getByRole('status')).toContainText('unknown')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Scheduled messages', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Refresh scheduled messages', exact: true }).click()
	await expect(dialog.getByRole('article')).toHaveCount(1)
	await expect(dialog.getByRole('article')).toContainText('unknown-batch')
})

// Replace only native dialogs in the isolated test app; production IPC and filesystem code execute unchanged.
async function fileDialogs(openFiles: string[] = [], saveFile = '') {
	await app.evaluate(
		({ dialog }, value) => {
			dialog.showOpenDialog = async () => ({
				canceled: !value.openFiles.length,
				filePaths: value.openFiles,
			})
			dialog.showSaveDialog = async () => ({
				canceled: !value.saveFile,
				filePath: value.saveFile,
			})
		},
		{ openFiles, saveFile },
	)
}
test('imports JSON and binary files, appends to the batch, saves drafts and sends only after review', async () => {
	await select('orders Active')
	const json = join(directory, 'order.json'),
		binary = join(directory, 'data.bin'),
		saved = join(directory, 'drafts.msgc.json')
	await writeFile(json, '{"number":9007199254740993,"city":"Málaga 🚀"}')
	await writeFile(binary, Buffer.from([0, 255, 65]))
	await fileDialogs([json, binary], saved)
	const composer = await compose('existing-draft', '{"keep":true}')
	await composer.getByRole('button', { name: 'Add draft to batch', exact: true }).click()
	await composer.getByLabel('Import file format', { exact: true }).selectOption('body')
	await composer.getByRole('button', { name: 'Import message files', exact: true }).click()
	await expect(composer.getByLabel('Import order.json message 1', { exact: true })).toBeChecked()
	await expect(composer.getByLabel('Import data.bin message 1', { exact: true })).toBeChecked()
	await expect(composer.getByLabel('Imported message IDs', { exact: true })).toHaveValue('new')
	await composer.evaluate((element) => {
		element.scrollTop = 0
	})
	await page.screenshot({ path: 'test-results/message-import-preview.png' })
	await composer.getByRole('button', { name: 'Add selected to batch (2)', exact: true }).click()
	await expect(
		composer.getByRole('heading', { name: 'Batch (3 / 20)', exact: true }),
	).toBeVisible()
	await composer.getByRole('button', { name: 'Save drafts to file', exact: true }).click()
	await expect(
		composer.getByText('Saved 3 draft(s) to drafts.msgc.json.', { exact: true }),
	).toBeVisible()
	const archive = JSON.parse(await readFile(saved, 'utf8'))
	expect(archive.format).toBe('msg-commander/messages')
	expect(archive.messages).toHaveLength(3)
	expect(Buffer.from(archive.messages[1].bodyBase64, 'base64').toString()).toContain(
		'9007199254740993',
	)
	expect(archive.messages[2].bodyBase64).toBe('AP9B')
	await composer.getByRole('button', { name: 'Send batch', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await expect(page.locator('.operation-outcome')).toContainText('3 message(s) sent')
	await peek()
	await expect(
		page.getByRole('button', { name: /9007199254741000 existing-draft/ }),
	).toBeVisible()
})
test('exports a received message archive, imports it with original metadata and exports the peek page', async () => {
	await select('orders Active')
	const archivePath = join(directory, 'received.msgc.json')
	await fileDialogs([], archivePath)
	const composer = await compose('archive-source', '{"copy":9007199254740993}')
	await composer.getByRole('button', { name: 'Add property', exact: true }).click()
	await composer.getByLabel('Property name 1', { exact: true }).fill('exact')
	await composer.getByLabel('Property type 1', { exact: true }).selectOption('int64')
	await composer.getByLabel('Property value 1', { exact: true }).fill('9223372036854775807')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await receive()
	const item = page.getByRole('article', { name: 'Received archive-source', exact: true })
	await item.getByRole('button', { name: 'Inspect received', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Save message', exact: true })
		.click()
	await expect(
		page
			.getByRole('dialog')
			.getByText('Saved 1 message(s) to received.msgc.json.', { exact: true }),
	).toBeVisible()
	expect(
		JSON.parse(await readFile(archivePath, 'utf8')).messages[0].applicationProperties,
	).toContainEqual({ name: 'exact', type: 'int64', value: '9223372036854775807' })
	await page.keyboard.press('Escape')
	await expect(item).toContainText('active') // Saving did not settle the owned lock.
	await fileDialogs([archivePath], join(directory, 'page.msgc.json'))
	await dismissMessage()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Import message files', exact: true }).click()
	await dialog.getByLabel('Imported message IDs', { exact: true }).selectOption('preserve')
	await expect(
		dialog.getByText('Preserved IDs can trigger destination duplicate detection.', {
			exact: false,
		}),
	).toBeVisible()
	await dialog.getByRole('button', { name: 'Add selected to batch (1)', exact: true }).click()
	await dialog.getByLabel('Edit batch message 1', { exact: true }).click()
	await expect(dialog.getByLabel('Message ID', { exact: true })).toHaveValue('archive-source')
	await expect(dialog.getByLabel('Property value 1', { exact: true })).toHaveValue(
		'9223372036854775807',
	)
	await dialog.getByText('Additional headers', { exact: true }).click()
	await expect(dialog.getByLabel('Exact TTL duration', { exact: true })).toBeVisible()
	await page.screenshot({ path: 'test-results/imported-message-editor.png' })
	await page.keyboard.press('Escape')
	await peek()
	await page.getByRole('button', { name: 'Export peek page', exact: true }).click()
	await expect(
		page.getByText('Saved 1 message(s) to page.msgc.json.', { exact: true }).first(),
	).toBeVisible()
	expect(
		JSON.parse(await readFile(join(directory, 'page.msgc.json'), 'utf8')).messages,
	).toHaveLength(1)
})
test('exports full body ranges, handles dialog cancellation and reports malformed imports without replacing drafts', async () => {
	await select('large Active')
	await peek()
	await page.getByRole('button', { name: '1 large', exact: true }).click()
	const bodyPath = join(directory, 'complete.bin')
	await fileDialogs([], bodyPath)
	await page.getByRole('button', { name: 'Save body to file', exact: true }).click()
	await expect(
		page.getByText('Saved 1 message(s) to complete.bin.', { exact: true }).first(),
	).toBeVisible()
	const bytes = await readFile(bodyPath)
	expect(bytes).toHaveLength(300000)
	expect(bytes.every((value, index) => value === index % 251)).toBe(true)
	await fileDialogs()
	await page.getByRole('button', { name: 'Save body to file', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Save body to file', exact: true })).toBeEnabled()
	expect(
		(await readdir(directory)).filter((name) => name.startsWith('.msg-commander-export-')),
	).toEqual([])
	const bad = join(directory, 'bad.json')
	await writeFile(bad, '{"wrong":"format"}')
	await fileDialogs([bad])
	const dialog = await compose('keep-me', '{"unchanged":true}')
	await dialog.getByRole('button', { name: 'Import message files', exact: true }).click()
	await expect(dialog.getByRole('alert')).toContainText('Unsupported or malformed')
	await expect(dialog.getByLabel('Message ID', { exact: true })).toHaveValue('keep-me')
	await expect(dialog.getByLabel('Message body', { exact: true })).toHaveValue(
		'{"unchanged":true}',
	)
	await fileDialogs()
	await dialog.getByRole('button', { name: 'Import message files', exact: true }).click()
	await expect(dialog.getByLabel('Message ID', { exact: true })).toHaveValue('keep-me')
})
test('requires explicit body-only import for archived binary properties and preserves dead letters', async () => {
	await select('orders Active')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await peek()
	await page.getByRole('button', { name: '9007199254740993 dead-order', exact: true }).click()
	const saved = join(directory, 'dead.msgc.json')
	await fileDialogs([], saved)
	await page.getByRole('button', { name: 'Save message', exact: true }).click()
	await expect(
		page.getByText('Saved 1 message(s) to dead.msgc.json.', { exact: true }).first(),
	).toBeVisible()
	expect(JSON.parse(await readFile(saved, 'utf8')).messages).toHaveLength(1)
	await fileDialogs([saved])
	await dismissMessage()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Import message files', exact: true }).click()
	await expect(
		dialog.getByLabel('Import dead.msgc.json message 1', { exact: true }),
	).toBeDisabled()
	await expect(
		dialog.getByText(/Application property type .*binary.* cannot be sent/),
	).toBeVisible()
	await dialog.getByLabel('Import content', { exact: true }).selectOption('body')
	await expect(
		dialog.getByLabel('Import dead.msgc.json message 1', { exact: true }),
	).toBeChecked()
	await dialog.getByRole('button', { name: 'Add selected to batch (1)', exact: true }).click()
	await dialog.getByLabel('Edit batch message 1', { exact: true }).click()
	await expect(dialog.getByLabel('Property name 1', { exact: true })).toHaveCount(0)
	await page.keyboard.press('Escape')
	await peek()
	await expect(
		page.getByRole('button', { name: '9007199254740993 dead-order', exact: true }),
	).toBeVisible()
})

async function sessions() {
	await page.getByRole('button', { name: 'Sessions', exact: true }).click()
	return page.getByRole('dialog')
}
async function acceptSessionUi(id: string) {
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Selected session ID', { exact: true }).fill(id)
	await dialog.getByRole('button', { name: 'Accept and inspect session', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Read session state', exact: true }),
	).toBeEnabled()
	return dialog
}
async function releaseSessionUi() {
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Release session', exact: true }).click()
	await dialog.getByRole('button', { name: 'Confirm release session', exact: true }).click()
	await expect(dialog.getByLabel('Selected session ID', { exact: true })).toBeEnabled()
	await expect(dialog.getByRole('region', { name: 'Owned session', exact: true })).toHaveCount(0)
}
test('lists state-only sessions, edits exact JSON state, renews and explicitly clears and releases', async () => {
	await select('sessions Sessions Active')
	const dialog = await sessions()
	await dialog.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
	await expect(dialog.getByText('100 sessions · page 1', { exact: true })).toBeVisible()
	await dialog.getByRole('button', { name: 'Next sessions', exact: true }).click()
	await expect(dialog.getByText('5 sessions · page 2', { exact: true })).toBeVisible()
	await dialog.getByRole('button', { name: 'state-only', exact: true }).click()
	await page.screenshot({ path: 'test-results/session-list.png', animations: 'disabled' })
	await dialog.getByRole('button', { name: 'Accept and inspect session', exact: true }).click()
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'retained with no messages',
	)
	await dialog.getByLabel('Session state encoding', { exact: true }).selectOption('text')
	await dialog
		.getByLabel('Session state editor', { exact: true })
		.fill('{"checkpoint":9007199254740993,"city":"Málaga 🚀"}')
	await dialog.getByLabel('Session state encoding', { exact: true }).selectOption('json')
	await dialog.getByRole('button', { name: 'Save session state', exact: true }).click()
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'9007199254740993',
	)
	await dialog.getByRole('button', { name: 'JSON', exact: true }).click()
	await page.screenshot({ path: 'test-results/session-state-editor.png', animations: 'disabled' })
	await dialog.getByRole('button', { name: 'Renew session lock', exact: true }).click()
	await expect(dialog.locator('.operation-outcome')).toContainText(
		'Broker acknowledged session lock renewal',
	)
	await dialog.getByRole('button', { name: 'Clear session state', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Confirm clear session state', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand the stored state for this session will be permanently cleared.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Confirm clear session state', exact: true }).click()
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'No stored session state',
	)
	await releaseSessionUi()
	await acceptSessionUi('state-only')
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'No stored session state',
	)
	await releaseSessionUi()
})
test('receives from the selected session and keeps ownership for another settled batch', async () => {
	await select('sessions Sessions Active')
	await sessions()
	let dialog = await acceptSessionUi('session-001')
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'9007199254740993',
	)
	await dialog.getByRole('button', { name: 'Receive from selected session', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	const item = page.getByRole('article', { name: 'Received received-001', exact: true })
	await expect(item).toContainText('active')
	await expect(page.getByLabel('Receive session ID', { exact: true })).toHaveValue('session-001')
	dialog = await sessions()
	await expect(
		dialog.getByRole('heading', { name: 'Owned session: session-001', exact: true }),
	).toBeVisible()
	await expect(
		dialog.getByRole('button', { name: 'Receive from selected session', exact: true }),
	).toBeDisabled()
	await page.keyboard.press('Escape')
	await item.getByRole('button', { name: 'Complete', exact: true }).click()
	await confirmAction('Confirm complete')
	dialog = await sessions()
	await dialog.getByRole('button', { name: 'Receive from selected session', exact: true }).click()
	await expect(
		page.getByRole('article', { name: 'Received received-002', exact: true }),
	).toBeVisible()
	dialog = await sessions()
	await releaseSessionUi()
	await expect(
		dialog.getByRole('heading', { name: 'Owned session: session-001', exact: true }),
	).toHaveCount(0)
	await page.keyboard.press('Escape')
	await expect(
		page.getByRole('article', { name: 'Received received-002', exact: true }),
	).toHaveCount(0)
})
test('inspects subscription binary state, rejects lossy conversion and makes large state read-only', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await select('audit Sessions Active')
	await sessions()
	const dialog = await acceptSessionUi('binary-state')
	await expect(dialog.getByLabel('Session state editor', { exact: true })).toHaveValue('AP9B')
	await dialog.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'00 ff 41',
	)
	await dialog.getByLabel('Session state encoding', { exact: true }).selectOption('text')
	await expect(dialog.getByRole('alert')).toContainText('cannot be converted to UTF-8')
	await expect(dialog.getByLabel('Session state editor', { exact: true })).toHaveValue('AP9B')
	await dialog.getByLabel('Session state editor', { exact: true }).fill('AP8AAUI=')
	await dialog.getByRole('button', { name: 'Save session state', exact: true }).click()
	await expect(dialog.getByLabel('Session state preview', { exact: true })).toContainText(
		'00 ff 00 01 42',
	)
	await releaseSessionUi()
	await acceptSessionUi('large-state')
	await expect(
		dialog
			.getByText(
				'State exceeds the 256 KiB local editor limit. It was not truncated or changed.',
				{
					exact: true,
				},
			)
			.first(),
	).toBeVisible()
	await expect(
		dialog.getByRole('button', { name: 'Save session state', exact: true }),
	).toHaveCount(0)
	await releaseSessionUi()
	await page.keyboard.press('Escape')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toHaveCount(0)
})
test('requires broker state reconciliation after uncertain writes and reports locked or lost sessions', async () => {
	await select('sessions Sessions Active')
	await sessions()
	const dialog = await acceptSessionUi('unknown-state')
	await dialog.getByLabel('Session state editor', { exact: true }).fill('AP9B')
	await dialog.getByRole('button', { name: 'Save session state', exact: true }).click()
	await expect(dialog.locator('.operation-outcome')).toContainText('UNKNOWN')
	await expect(
		dialog.getByRole('button', { name: 'Save session state', exact: true }),
	).toBeDisabled()
	await dialog.getByRole('button', { name: 'Read session state', exact: true }).click()
	await expect(dialog.getByLabel('Session state editor', { exact: true })).toHaveValue('AP9B')
	await expect(
		dialog.getByRole('button', { name: 'Save session state', exact: true }),
	).toBeEnabled()
	await releaseSessionUi()
	await dialog.getByLabel('Selected session ID', { exact: true }).fill('locked-session')
	await dialog.getByRole('button', { name: 'Accept and inspect session', exact: true }).click()
	await expect(dialog.getByRole('alert')).toContainText('locked by another receiver')
	await dialog.getByLabel('Selected session ID', { exact: true }).fill('lost-session')
	await dialog.getByRole('button', { name: 'Accept and inspect session', exact: true }).click()
	await expect(dialog.getByRole('alert')).toContainText('session lock was lost')
	await expect(
		dialog.getByRole('button', { name: 'Renew session lock', exact: true }),
	).toBeDisabled()
	await expect(
		dialog.getByRole('button', { name: 'Receive from selected session', exact: true }),
	).toBeDisabled()
	await releaseSessionUi()
})

async function openPurge() {
	await page.getByRole('button', { name: 'Purge messages', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await dialog
		.getByLabel('I understand these deletions are permanent and may include new arrivals.', {
			exact: true,
		})
		.check()
	return dialog
}

test('requires checkbox purge confirmation, isolates the queue DLQ and reports a bounded main-queue purge', async () => {
	await select('orders Active')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	const dialog = await openPurge()
	await dialog.getByRole('checkbox', { name: /I understand these deletions/ }).uncheck()
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await dialog.getByRole('checkbox', { name: /I understand these deletions/ }).check()
	await page.screenshot({ path: 'test-results/purge-confirmation.png', animations: 'disabled' })
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'not guaranteed empty',
	)
	await page.keyboard.press('Escape')
	await peek()
	await expect(
		page.getByText('No messages returned at this sequence.', { exact: false }),
	).toBeVisible()
	await dismissMessage()
	await page.getByRole('button', { name: 'Main queue', exact: true }).click()
	await peek()
	await expect(page.getByRole('button', { name: /received-001/, exact: false })).toBeVisible()
	await openPurge()
	await dialog.getByLabel('Maximum purge deletions', { exact: true }).fill('1')
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await dialog.getByRole('checkbox', { name: /I understand these deletions/ }).check()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'Message limit reached',
	)
	await page.screenshot({ path: 'test-results/purge-result.png', animations: 'disabled' })
	await page.keyboard.press('Escape')
	await peek()
	await expect(page.getByRole('button', { name: /received-002/, exact: false })).toBeVisible()
})

test('purges session-enabled subscriptions and their dead letters without offering topic purge', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	await expect(page.getByRole('button', { name: 'Purge messages', exact: true })).toHaveCount(0)
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await select('audit Sessions Active')
	const dialog = await openPurge()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'2 deletions confirmed',
	)
	await page.keyboard.press('Escape')
	await dismissMessage()
	await page.getByRole('button', { name: 'Dead-letter', exact: true }).click()
	await openPurge()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await page.keyboard.press('Escape')
	await select('billing Active')
	await openPurge()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'2 deletions confirmed',
	)
})

test('shows purge progress, cancels with partial counts and blocks purging an owned receiver', async () => {
	await select('orders Active')
	for (const id of ['first', 'purge-wait-receive']) {
		const composer = await compose(id, '{"body":true}')
		await composer.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(composer).toHaveCount(0)
	}
	const dialog = await openPurge()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await expect(dialog.getByRole('progressbar', { name: 'Purge progress' })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText('cancelled')
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toHaveCount(0)
	await page.keyboard.press('Escape')
	await peek()
	await expect(
		page.getByRole('button', { name: /purge-wait-receive/, exact: false }),
	).toBeVisible()
	await select('sessions Sessions Active')
	const sessionDialog = await sessions()
	await sessionDialog.getByLabel('Selected session ID', { exact: true }).fill('state-only')
	await sessionDialog
		.getByRole('button', { name: 'Accept and inspect session', exact: true })
		.click()
	await expect(sessionDialog.getByRole('region', { name: 'Owned session' })).toBeVisible()
	await page.keyboard.press('Escape')
	await openPurge()
	await expect(dialog).toContainText('Close the current message or session receiver')
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
})

test('reports an uncertain purge completion and preserves remaining messages without automatic retry', async () => {
	await select('orders Active')
	for (const id of ['unknown-complete', 'untouched']) {
		const composer = await compose(id, '{"body":true}')
		await composer.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(composer).toHaveCount(0)
	}
	const dialog = await openPurge()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText('unknown')
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'0 deletions confirmed',
	)
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 completion(s) uncertain',
	)
	await page.keyboard.press('Escape')
	await peek()
	await expect(page.getByRole('button', { name: /untouched/, exact: false })).toBeVisible()
	await expect(page.getByRole('button', { name: /unknown-complete/, exact: false })).toHaveCount(
		0,
	)
})

const sasResourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ServiceBus/namespaces/fixture'
async function signInSas(tenant = 'fixture') {
	await page.getByLabel('Namespace resource ID', { exact: true }).fill(sasResourceId)
	await page.getByLabel('Management tenant ID', { exact: true }).fill(tenant)
	await page
		.getByLabel('Management application ID', { exact: true })
		.fill('22222222-2222-4222-8222-222222222222')
	await page.getByRole('button', { name: 'Sign in to management', exact: true }).click()
}
async function confirmSas() {
	await expect(page.getByLabel('Confirm SAS change', { exact: true })).toHaveCount(0)
	await page
		.getByRole('checkbox', {
			name: 'I understand this can revoke access or change client permissions.',
		})
		.check()
}
async function createSas(name: string) {
	await page.getByRole('button', { name: 'Create SAS rule', exact: true }).click()
	await page.getByLabel('SAS rule name', { exact: true }).fill(name)
	await page.getByRole('button', { name: 'Create SAS rule', exact: true }).click()
	await expect(
		page.getByRole('button', { name: `Edit SAS rule ${name}`, exact: true }),
	).toBeVisible()
}

test('manages namespace SAS rules with explicit rights and guarded deletion', async () => {
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await signInSas()
	await expect(page.getByRole('table', { name: 'SAS authorization rules' })).toContainText(
		'RootManageSharedAccessKey',
	)
	await createSas('desktop-client')
	await page.getByRole('button', { name: 'Edit SAS rule desktop-client', exact: true }).click()
	await page.getByRole('checkbox', { name: 'Manage', exact: true }).check()
	await expect(page.getByRole('checkbox', { name: 'Send', exact: true })).toBeChecked()
	await expect(page.getByRole('checkbox', { name: 'Listen', exact: true })).toBeChecked()
	await expect(page.getByRole('button', { name: 'Save SAS rights', exact: true })).toBeDisabled()
	await confirmSas()
	await page.getByRole('button', { name: 'Save SAS rights', exact: true }).click()
	await expect(page.getByRole('table', { name: 'SAS authorization rules' })).toContainText(
		'Listen, Manage, Send',
	)
	await page.getByRole('button', { name: 'Delete SAS rule desktop-client', exact: true }).click()
	await expect(page.getByLabel('Confirm SAS change', { exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Delete SAS rule', exact: true })).toBeDisabled()
	await confirmSas()
	await page.screenshot({ path: 'test-results/sas-delete-confirmation.png' })
	await page.getByRole('button', { name: 'Delete SAS rule', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Edit SAS rule desktop-client', exact: true }),
	).toHaveCount(0)
	await expect(page.getByRole('table', { name: 'SAS authorization rules' })).toContainText(
		'RootManageSharedAccessKey',
	)
	expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(sasResourceId)
})

test('reveals and copies selected SAS keys on demand and rotates queue and topic slots independently', async () => {
	const clipboard = await app.evaluateHandle(({ clipboard }) => {
		const captured = { text: '' }
		clipboard.writeText = async (text: string) => {
			captured.text = text
		}
		return captured
	})
	await select('orders Active')
	await page.getByRole('button', { name: 'Selected queue SAS rules', exact: true }).click()
	await signInSas()
	for (const [kind, entity, name] of [
		['queue', 'orders', 'sender'],
		['topic', 'order-events', 'subscriber'],
	] as const) {
		if (kind === 'topic') {
			await page
				.getByRole('dialog')
				.getByRole('button', { name: 'Close', exact: true })
				.click()
			await dismissMessage()
			await page.getByRole('button', { name: 'Topics', exact: true }).click()
			await select('order-events Active')
			await page
				.getByRole('button', { name: 'Selected topic SAS rules', exact: true })
				.click()
		}
		await page.getByRole('button', { name: `Keys for SAS rule ${name}`, exact: true }).click()
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
		await page.getByLabel('Key slot', { exact: true }).selectOption('SecondaryKey')
		await page.getByRole('button', { name: 'Copy connection string', exact: true }).click()
		expect(await clipboard.evaluate((value) => value.text)).toContain(
			'SharedAccessKey=fixture-secondary-secret;EntityPath=' + entity,
		)
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
		await page.getByLabel('Key slot', { exact: true }).selectOption('PrimaryKey')
		await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveValue(
			'fixture-primary-secret',
		)
		await page.getByRole('button', { name: 'Regenerate selected key…', exact: true }).click()
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
		await expect(
			page.getByRole('button', { name: 'Regenerate key', exact: true }),
		).toBeDisabled()
		await confirmSas()
		await page.getByRole('button', { name: 'Regenerate key', exact: true }).click()
		await page.getByRole('button', { name: `Keys for SAS rule ${name}`, exact: true }).click()
		await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveValue(
			/fixture-primary-rotated-/,
		)
		await page.getByLabel('Key slot', { exact: true }).selectOption('SecondaryKey')
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
		await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
		await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveValue(
			'fixture-secondary-secret',
		)
		await page.getByRole('button', { name: 'Hide keys', exact: true }).click()
	}
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
	if (await page.getByRole('button', { name: 'Show Operations log', exact: true }).count())
		await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).not.toContainText(
		'fixture-primary',
	)
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).not.toContainText(
		'fixture-secondary',
	)
	expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(
		'fixture-primary',
	)
	expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(
		'fixture-secondary',
	)
})

test('blocks further SAS writes after an uncertain rotation even after reopening the manager', async () => {
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await signInSas()
	await createSas('uncertain')
	await page.getByRole('button', { name: 'Keys for SAS rule uncertain', exact: true }).click()
	await page.getByRole('button', { name: 'Regenerate selected key…', exact: true }).click()
	await confirmSas()
	await page.getByRole('button', { name: 'Regenerate key', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('Outcome unknown')
	await expect(page.getByRole('button', { name: 'Regenerate key', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Check SAS result', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('Further SAS changes are blocked')
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Create SAS rule', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Keys for SAS rule uncertain', exact: true }).click()
	await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
	await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveValue(
		'fixture-primary-rotated-1',
	)
	await page.getByRole('button', { name: 'Hide keys', exact: true }).click()
	await page.screenshot({ path: 'test-results/sas-uncertain-rotation.png' })
})

test('reports SAS management permission failures and supports cancellation of sign-in and rotation', async () => {
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await signInSas('denied')
	await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
		'Azure Resource Manager denied',
	)
	await signInSas('slow')
	await expect(page.getByRole('dialog')).toContainText('OFFLINE-CODE')
	await page.getByRole('button', { name: 'Cancel SAS operation', exact: true }).click()
	await expect(page.getByRole('dialog').getByRole('alert')).toContainText('cancelled')
	await signInSas()
	await createSas('slow')
	await page.getByRole('button', { name: 'Keys for SAS rule slow', exact: true }).click()
	await page.getByRole('button', { name: 'Regenerate selected key…', exact: true }).click()
	await confirmSas()
	await page.getByRole('button', { name: 'Regenerate key', exact: true }).click()
	await page.getByRole('button', { name: 'Cancel SAS operation', exact: true }).click()
	await page.getByRole('button', { name: 'Check SAS result', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('unknown')
	await expect(page.getByRole('button', { name: 'Regenerate key', exact: true })).toBeDisabled()
	await expect(page.getByRole('dialog')).not.toContainText('SECRET')
})

test('automatically hides revealed SAS keys and clears them on close and scope changes', async () => {
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await signInSas()
	await page
		.getByRole('button', { name: 'Keys for SAS rule RootManageSharedAccessKey', exact: true })
		.click()
	await page.clock.install()
	await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
	await expect(page.getByLabel('Revealed SAS key', { exact: true })).toBeVisible()
	await page.clock.fastForward(30001)
	await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Reveal selected key', exact: true }).click()
	await expect(page.getByLabel('Revealed SAS key', { exact: true })).toBeVisible()
	await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
	await page.getByRole('button', { name: 'Namespace SAS rules', exact: true }).click()
	await expect(page.getByLabel('Revealed SAS key', { exact: true })).toHaveCount(0)
})

async function previewCopy(name: string, rename = false) {
	await page
		.getByRole('button', {
			name: rename ? 'Rename selected entity' : 'Duplicate selected entity',
			exact: true,
		})
		.click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Copy destination name', { exact: true }).fill(name)
	await dialog.getByRole('button', { name: 'Preview configuration copy', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Entity copy preview', exact: true }),
	).toBeVisible()
	return dialog
}
async function confirmCopy(rename = false) {
	const dialog = page.getByRole('dialog')
	await expect(dialog.getByLabel('Confirm entity copy or removal', { exact: true })).toHaveCount(
		0,
	)
	await dialog
		.getByLabel(
			'I reviewed the copied settings and understand that messages and credentials are not copied.',
			{ exact: true },
		)
		.check()
	await dialog
		.getByRole('button', {
			name: rename ? 'Create renamed destination' : 'Duplicate entity',
			exact: true,
		})
		.click()
}
async function createCopyQueue(name: string) {
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Entity name', { exact: true }).fill(name)
	await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(dialog).toHaveCount(0)
}
test('duplicates entity configuration with a preview, exact confirmation and a verified receipt', async () => {
	await select('orders Active')
	const dialog = await previewCopy('copy-orders')
	await expect(
		dialog.getByRole('button', { name: 'Duplicate entity', exact: true }),
	).toBeDisabled()
	await dialog.locator('summary').click()
	await expect(
		dialog.getByRole('table', { name: 'Copied settings for copy-orders' }),
	).toBeVisible()
	await page.screenshot({ path: 'test-results/entity-copy-preview.png' })
	await confirmCopy()
	const result = dialog.getByRole('region', { name: 'Entity copy result', exact: true })
	await expect(result).toContainText('Configuration copy verified')
	await expect(dialog.getByRole('table', { name: 'Entity copy steps' })).toContainText(
		'Verify destination',
	)
	await page.keyboard.press('Escape')
	await select('copy-orders Active')
	await peek()
	await expect(
		page.getByText('0 messages from 0 · Next sequence: 0', { exact: true }),
	).toBeVisible()
})
test('previews and copies topics with subscriptions and their rules by default', async () => {
	await dismissMessage()
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	await select('order-events Active')
	const dialog = await previewCopy('copy-topic')
	await expect(
		dialog.getByLabel('Include subscriptions and their rules', { exact: true }),
	).toBeChecked()
	await expect(dialog.getByRole('region', { name: 'Entity copy preview' })).toContainText(
		'3 entities',
	)
	await dialog.locator('summary').filter({ hasText: 'billing' }).click()
	await expect(
		dialog.locator('details[open]').getByText('$Default · true', { exact: true }),
	).toBeVisible()
	await confirmCopy()
	await expect(dialog.getByRole('region', { name: 'Entity copy result' })).toContainText(
		'Configuration copy verified',
	)
	await page.keyboard.press('Escape')
	await select('copy-topic Active')
	await dismissMessage()
	await page.getByRole('button', { name: 'Browse subscriptions', exact: true }).click()
	await expect(page.getByRole('button', { name: 'billing Active', exact: true })).toBeVisible()
	await select('billing Active')
	await previewCopy('billing-copy')
	await confirmCopy()
	await expect(page.getByRole('region', { name: 'Entity copy result' })).toContainText(
		'Configuration copy verified',
	)
})
test('stages a rename, retains the source and requires a new review and separate permanent deletion confirmation', async () => {
	await createCopyQueue('copy-source')
	let dialog = await previewCopy('copy-renamed', true)
	await confirmCopy(true)
	await expect(dialog.getByRole('region', { name: 'Entity copy result' })).toContainText(
		'The source remains',
	)
	await dialog.getByRole('button', { name: 'Review source removal', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Rename source review' })).toContainText(
		'Disable the source',
	)
	await expect(
		dialog.getByRole('button', { name: 'Delete old source', exact: true }),
	).toBeDisabled()
	await page.keyboard.press('Escape')
	await select('copy-source Active')
	await page.getByRole('button', { name: 'Edit queue', exact: true }).click()
	dialog = page.getByRole('dialog')
	await dialog.getByLabel('Entity status', { exact: true }).selectOption('Disabled')
	await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await page.getByRole('button', { name: 'Copy / rename jobs', exact: true }).click()
	dialog = page.getByRole('dialog')
	await dialog.getByRole('button', { name: 'Review source removal', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Rename source review' }).getByRole('alert'),
	).toHaveCount(0)
	await expect(
		dialog.getByRole('button', { name: 'Delete old source', exact: true }),
	).toBeDisabled()
	await expect(dialog.getByLabel('Confirm entity copy or removal', { exact: true })).toHaveCount(
		0,
	)
	await dialog
		.getByLabel(
			'I switched clients, stopped source traffic, and accept permanent source deletion.',
			{ exact: true },
		)
		.check()
	await page.screenshot({ path: 'test-results/entity-rename-review.png' })
	await dialog.getByRole('button', { name: 'Delete old source', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Source removal result' })).toContainText(
		'confirmed',
	)
	await page.keyboard.press('Escape')
	await expect(
		page.getByRole('button', { name: 'copy-source Disabled', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'copy-renamed Active', exact: true }),
	).toBeVisible()
})
test('cancels a dispatched copy, keeps the uncertain receipt and blocks another copy', async () => {
	await select('empty Active')
	const dialog = await previewCopy('slow-copy')
	await confirmCopy()
	await expect(dialog.getByRole('progressbar', { name: 'Entity copy progress' })).toBeVisible()
	await dialog
		.getByRole('button', { name: 'Cancel copy / rename operation', exact: true })
		.click()
	await expect(dialog.getByRole('region', { name: 'Entity copy result' })).toContainText(
		'unknown',
	)
	await dialog.getByRole('button', { name: 'Check copy result', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Entity copy result' })).toContainText(
		'Source retained',
	)
	await page.screenshot({ path: 'test-results/entity-copy-uncertain.png' })
	await page.keyboard.press('Escape')
	await select('orders Active')
	await expect(
		page.getByRole('button', { name: 'Duplicate selected entity', exact: true }),
	).toBeDisabled()
})
test('rejects a destination collision without offering execution', async () => {
	await select('empty Active')
	await page.getByRole('button', { name: 'Duplicate selected entity', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByLabel('Copy destination name', { exact: true }).fill('orders')
	await dialog.getByRole('button', { name: 'Preview configuration copy', exact: true }).click()
	await expect(dialog.getByRole('alert')).toContainText('Destination already exists')
	await expect(dialog.getByRole('button', { name: 'Duplicate entity', exact: true })).toHaveCount(
		0,
	)
})

test('tree opens subscription messages and dead letters directly while retaining expanded branches and modal focus', async () => {
	await page.locator('.entity-admin > summary').click()
	await expect(
		page.getByRole('region', { name: 'Namespace message counters' }).getByRole('status'),
	).toContainText('Updated')
	await expect(page.getByLabel('Dead-letter count', { exact: true })).toContainText('11')
	await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
	await page
		.getByRole('button', {
			name: 'Expand subscription order-events/Subscriptions/billing',
			exact: true,
		})
		.click()
	await page
		.getByRole('button', {
			name: 'order-events/Subscriptions/billing Dead-letter',
			exact: true,
		})
		.click()
	const row = page.getByRole('button', { name: '9007199254740993 dead-order', exact: true })
	await expect(row).toBeInViewport()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
	await page.screenshot({ path: 'test-results/namespace-tree.png' })
	await row.click()
	const inspector = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(inspector.getByTestId('message-body')).toBeVisible()
	await expect(inspector).toContainText('ValidationFailed')
	const bounds = await inspector.boundingBox()
	expect(bounds!.y).toBeGreaterThanOrEqual(0)
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
		(await page.evaluate(() => innerHeight)) + 1,
	)
	await page.screenshot({ path: 'test-results/message-modal.png' })
	await page.keyboard.press('Escape')
	await expect(row).toBeFocused()
	await expect(
		page.getByRole('button', { name: 'Collapse topic order-events', exact: true }),
	).toBeVisible()
	await page
		.getByRole('button', { name: 'order-events/Subscriptions/billing Messages', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: '9007199254740993 order-001', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Expand queue orders', exact: true }).click()
	await page.getByRole('button', { name: 'orders Dead-letter', exact: true }).click()
	await expect(
		page.getByRole('button', {
			name: 'Collapse subscription order-events/Subscriptions/billing',
			exact: true,
		}),
	).toBeVisible()
})
test('namespace counters refresh on the selected interval, can pause, and preserve the message page and inspector', async () => {
	await page.locator('.entity-admin > summary').click()
	const overview = page.getByRole('region', { name: 'Namespace message counters' })
	await expect(overview.getByRole('status')).toContainText('Updated')
	await page.getByRole('button', { name: 'Namespace statistics' }).click()
	const active = page.getByLabel('Active messages count', { exact: true })
	await expect(active).toContainText('22')
	await page.getByLabel('Counter refresh interval').selectOption('0')
	await page.clock.install()
	await select('empty Active')
	const composer = await compose('counter-update', '{"counter":true}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await peek()
	const row = page.getByRole('button', { name: /9007199254741000 counter-update/ })
	await expect(row).toBeVisible()
	await page.clock.fastForward(60000)
	await expect(active).toContainText('22') // Paused refresh has not silently read new data.
	await page.getByLabel('Counter refresh interval').selectOption('10')
	await row.click()
	const inspector = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(inspector.getByTestId('message-body')).toContainText('counter')
	await page.clock.fastForward(11000)
	await expect(page.locator('[aria-label="Active messages count"]')).toContainText('23')
	await expect(inspector.getByTestId('message-body')).toContainText('counter')
	await page.keyboard.press('Escape')
	await expect(row).toBeVisible()
	await page.getByLabel('Counter refresh interval').selectOption('0')
	await page.getByRole('button', { name: 'Refresh namespace counts', exact: true }).click()
	await expect(active).toContainText('23')
})
test('tree has keyboard expansion, independent scrolling and keeps the namespace overview visible at a small window size', async () => {
	await page.locator('.entity-admin > summary').click()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	const expand = page.getByRole('button', { name: 'Expand queue orders', exact: true })
	await expand.focus()
	await page.keyboard.press('ArrowRight')
	await expect(page.getByRole('button', { name: 'orders Messages', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'orders Messages', exact: true }).click()
	await page.locator('.entity-workspace').evaluate((element) => {
		element.scrollTop = element.scrollHeight
	})
	await expect(page.getByRole('region', { name: 'Namespace message counters' })).toBeInViewport()
	await expect(
		page.getByRole('button', { name: 'orders Messages', exact: true }),
	).toBeInViewport()
	await expect(
		page.getByRole('region', { name: 'Namespace message counters' }).getByRole('status'),
	).toContainText('Updated')
	await page.screenshot({ path: 'test-results/namespace-compact.png' })
})

async function treeMenu(name: string, item: string) {
	await page
		.getByRole('complementary', { name: 'Entities', exact: true })
		.getByRole('button', { name, exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: item, exact: true }).click()
	return page.getByRole('dialog')
}

test('tree context menus create, edit and delete the clicked queue without using the selected entity', async () => {
	await page.locator('.entity-admin > summary').click()
	await select('orders Active')
	let dialog = await treeMenu('empty Active', 'Edit queue…')
	await expect(dialog.getByLabel('Entity name', { exact: true })).toHaveValue('empty')
	await dialog.getByLabel('User metadata', { exact: true }).fill('edited through tree')
	await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	dialog = await treeMenu('Queues', 'Create queue…')
	await dialog.getByLabel('Entity name', { exact: true }).fill('context-queue')
	await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await select('orders Active')
	dialog = await treeMenu('context-queue Active', 'Delete queue…')
	await expect(
		dialog.getByRole('button', { name: 'Permanently delete queue', exact: true }),
	).toBeDisabled()
	await expect(dialog.getByLabel('Confirm entity path', { exact: true })).toHaveCount(0)
	await expect(
		dialog.getByRole('button', { name: 'Permanently delete queue', exact: true }),
	).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I understand this queue and all its messages will be permanently deleted.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Permanently delete queue', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'context-queue Active', exact: true }),
	).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
	await expect(page.locator('.entity-admin')).not.toHaveAttribute('open')
})

test('tree context menus preserve topic and subscription scope for creation, duplication and staged rename', async () => {
	await page.locator('.entity-admin > summary').click()
	await select('orders Active')
	let dialog = await treeMenu('order-events Active', 'Create subscription…')
	await expect(dialog.getByLabel('Parent topic', { exact: true })).toHaveValue('order-events')
	await dialog.getByLabel('Entity name', { exact: true }).fill('context-sub')
	await dialog.getByRole('button', { name: 'Create subscription', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await select('orders Active')
	dialog = await treeMenu('context-sub Active', 'Duplicate subscription…')
	await expect(dialog.getByLabel('Copy destination topic', { exact: true })).toHaveValue(
		'order-events',
	)
	await expect(dialog.getByLabel('Copy destination name', { exact: true })).toHaveValue(
		'context-sub-copy',
	)
	await dialog.getByRole('button', { name: 'Preview configuration copy', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Entity copy preview' })).toContainText(
		'order-events/Subscriptions/context-sub',
	)
	await page.keyboard.press('Escape')
	dialog = await treeMenu('context-sub Active', 'Rename subscription…')
	await expect(dialog).toContainText('keeps the source')
	await expect(dialog.getByLabel('Copy destination topic', { exact: true })).toHaveValue(
		'order-events',
	)
	await expect(dialog.getByLabel('Copy destination topic', { exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('Copy destination name', { exact: true })).toHaveValue('')
	await page.keyboard.press('Escape')
	await page
		.getByRole('button', { name: 'context-sub Active', exact: true })
		.click({ button: 'right' })
	await expect(page.getByRole('menuitem', { name: 'Send messages…', exact: true })).toHaveCount(0)
	await page.keyboard.press('Escape')
	await page
		.getByRole('button', { name: 'order-events Active', exact: true })
		.click({ button: 'right' })
	await expect(page.getByRole('menuitem', { name: 'Purge messages…', exact: true })).toHaveCount(
		0,
	)
	await page.screenshot({ path: 'test-results/tree-context-menu.png' })
	await page.keyboard.press('Escape')
})

test('tree context menus send to the clicked queue and confirm the exact dead-letter purge destination', async () => {
	await page.locator('.entity-admin > summary').click()
	await select('orders Active')
	let dialog = await treeMenu('empty Active', 'Send messages…')
	await expect(dialog.locator('.write-destination')).toContainText('empty')
	await dialog.getByLabel('Message ID', { exact: true }).fill('context-send')
	await dialog.getByLabel('Message body', { exact: true }).fill('{"message":"from context menu"}')
	await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await page.getByRole('button', { name: 'Expand queue orders', exact: true }).click()
	dialog = await treeMenu('orders Dead-letter', 'Purge dead-letter messages…')
	await expect(dialog.locator('.write-destination')).toContainText('orders')
	await expect(dialog.locator('.write-destination')).toContainText('Dead-letter queue')
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', {
			name: 'I understand these deletions are permanent and may include new arrivals.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled()
	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
	await treeMenu('empty Active', 'Peek messages')
	await expect(page.getByRole('button', { name: /context-send/, exact: false })).toBeVisible()
	await page.getByRole('button', { name: 'orders Dead-letter', exact: true }).click()
	await expect(
		page.getByText('No messages returned at this sequence.', { exact: false }),
	).toBeVisible()
	await page.getByRole('button', { name: 'orders Messages', exact: true }).click()
	await expect(page.getByRole('button', { name: /received-00[12]/ })).toHaveCount(2)
})

test('expand and collapse all include paged entities and subscriptions and keyboard context menus preserve focus', async () => {
	await page.locator('.entity-admin > summary').click()
	await select('orders Active')
	await peek()
	const row = page.getByRole('button', { name: '9007199254740993 order-001', exact: true })
	await page.getByRole('button', { name: 'Expand all entities', exact: true }).click()
	await expect(page.getByRole('button', { name: 'archive Messages', exact: true })).toBeVisible()
	await expect(
		page.getByRole('button', {
			name: 'order-events/Subscriptions/audit Dead-letter',
			exact: true,
		}),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Expand all entities', exact: true }),
	).toBeEnabled()
	await expect(row).toBeVisible()
	await page.getByRole('button', { name: 'Collapse all entities', exact: true }).click()
	const tree = page.getByRole('tree', { name: 'Namespace entities' })
	await expect(tree.getByRole('treeitem')).toHaveCount(2)
	await expect(row).toBeVisible()
	const queues = page.getByRole('button', { name: 'Queues', exact: true })
	await queues.focus()
	await page.keyboard.press('Shift+F10')
	await expect(page.getByRole('menuitem', { name: 'Create queue…', exact: true })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(queues).toBeFocused()
	await page.getByRole('button', { name: 'Expand all entities', exact: true }).click()
	await expect(
		page.getByRole('button', {
			name: 'order-events/Subscriptions/billing Messages',
			exact: true,
		}),
	).toBeVisible()
})

test('layout toggles maximize content, preserve message state and running jobs, and restore after reload', async () => {
	await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await page.locator('.entity-admin > summary').click()
	await select('orders Active')
	await peek()
	const row = page.getByRole('button', { name: '9007199254740993 order-001', exact: true })
	const initial = await page.locator('.entity-workspace').boundingBox()
	await page.getByRole('button', { name: 'Hide navigation sidebar', exact: true }).click()
	await expect(
		page.getByRole('complementary', { name: 'Workspace navigation' }),
	).not.toBeVisible()
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await page.getByRole('button', { name: 'Hide Operations log', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).not.toBeVisible()
	await expect(row).toBeVisible()
	const maximized = await page.locator('.entity-workspace').boundingBox()
	expect(maximized!.width).toBeGreaterThan(initial!.width + 300)
	expect(maximized!.height).toBeGreaterThan(initial!.height + 50)
	await page.screenshot({ path: 'test-results/maximized-workspace.png' })
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await select('slow Active')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Show Operations log', exact: true }),
	).toContainText('1')
	await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await page
		.getByRole('region', { name: 'Operations', exact: true })
		.getByRole('button', { name: 'Cancel', exact: true })
		.click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await page.getByRole('button', { name: 'Hide Operations log', exact: true }).click()
	await expect
		.poll(() =>
			page.evaluate(() => {
				const saved = JSON.parse(localStorage.getItem('reka:commander-jobs-v4') ?? '{}')
				return Object.values(saved).some(
					(state) => (state as { layout?: number[] }).layout?.[1] === 0,
				)
			}),
		)
		.toBe(true)
	await page.reload()
	await expect(
		page.getByRole('button', { name: 'Show navigation sidebar', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Show Operations log', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Show navigation sidebar', exact: true }).click()
	await page
		.getByRole('button', {
			name: 'Offline namespace fixture.servicebus.windows.net',
			exact: true,
		})
		.click()
	await page.getByRole('button', { name: 'Connect and browse' }).click()
	await expect(page.getByRole('button', { name: 'Show entity tree', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
})

async function seedDeadLetter(id = 'resend-original') {
	await select('empty Active')
	const composer = await compose(id, '{"order":9007199254740993,"city":"Málaga"}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
	await receive()
	const message = page.getByRole('article', { name: `Received ${id}`, exact: true })
	await message.getByRole('button', { name: 'Dead-letter received', exact: true }).click()
	await confirmAction('Confirm dead-letter')
	await expect(message).toContainText('dead-lettered')
	await page.getByRole('button', { name: 'Close receiver', exact: true }).click()
	await confirmAction('Close and let locks expire')
}
async function confirmResend() {
	const dialog = page.getByRole('dialog', { name: 'Resend dead-letter messages', exact: true })
	await expect(dialog.getByLabel('Resend confirmation', { exact: true })).toHaveCount(0)
	await expect(dialog.getByText('Type this exact confirmation:', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', {
			name: 'I have reviewed the destination, message IDs and original-message behavior.',
			exact: true,
		})
		.check()
	return dialog
}

test('tree resend keeps originals by default and uses the clicked source without a typed confirmation', async () => {
	await seedDeadLetter()
	await select('orders Active')
	const dialog = await treeMenu('empty Active', 'Resend dead-letter messages…')
	await expect(dialog.locator('.write-destination')).toContainText('Source: empty / Dead-letter')
	await expect(
		dialog.getByRole('radio', { name: 'Keep originals in the dead-letter queue' }),
	).toBeChecked()
	await expect(dialog.getByLabel('Resend destination name', { exact: true })).toHaveValue('empty')
	await expect(dialog.getByLabel('Resend message ID policy', { exact: true })).toHaveValue('new')
	await expect(dialog.getByRole('button', { name: 'Start resend', exact: true })).toBeDisabled()
	await confirmResend()
	await dialog.getByLabel('Maximum resend messages', { exact: true }).fill('1')
	await expect(dialog.getByRole('button', { name: 'Start resend', exact: true })).toBeDisabled()
	await confirmResend()
	await page.screenshot({ path: 'test-results/dead-letter-resend-confirmation.png' })
	await dialog.getByRole('button', { name: 'Start resend', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Resend result', exact: true })
	await expect(result).toContainText('1 resends confirmed · 0 originals removed · 0 uncertain')
	await expect(result).toContainText('Message limit reached')
	await page.screenshot({ path: 'test-results/dead-letter-resend-result.png' })
	await page.keyboard.press('Escape')
	await treeMenu('empty Active', 'Peek dead-letter messages')
	await expect(
		page.locator('.message-table').getByRole('button', { name: /resend-original/ }),
	).toHaveCount(1)
	await treeMenu('empty Active', 'Peek messages')
	const copies = page.locator('.message-table tbody').getByRole('button')
	await expect(copies).toHaveCount(1)
	await expect(copies).not.toContainText('resend-original')
	await copies.click()
	await expect(page.getByTestId('message-body')).toContainText('9007199254740993')
	await expect(page.getByTestId('message-body')).toContainText('Málaga')
})

test('dead-letter child menu removes originals only after resending and warns about preserved IDs', async () => {
	await seedDeadLetter()
	await page.getByRole('button', { name: 'Expand queue empty', exact: true }).click()
	const dialog = await treeMenu('empty Dead-letter', 'Resend dead-letter messages…')
	await confirmResend()
	await dialog.getByRole('radio', { name: 'Remove originals after successful resend' }).check()
	await expect(dialog.getByRole('button', { name: 'Start resend', exact: true })).toBeDisabled()
	await expect(dialog).toContainText('Only successfully transferred originals are removed')
	await dialog.getByLabel('Resend message ID policy', { exact: true }).selectOption('preserve')
	await expect(dialog).toContainText('Duplicate detection can acknowledge and discard')
	await confirmResend()
	await dialog.getByRole('button', { name: 'Start resend', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Resend result' })).toContainText(
		'1 resends confirmed · 1 originals removed · 0 uncertain',
	)
	await dialog.getByRole('button', { name: 'Close', exact: true }).click()
	await expect(dialog).not.toBeVisible()
	await select('empty Dead-letter')
	await expect(
		page.getByText('No messages returned at this sequence.', { exact: false }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Resend dead-letter messages', exact: true }).click()
	await expect(page.getByRole('dialog').locator('.write-destination')).toContainText(
		'Source: empty / Dead-letter',
	)
	await page.keyboard.press('Escape')
	await select('empty Messages')
	await expect(
		page.locator('.message-table').getByRole('button', { name: /resend-original/ }),
	).toHaveCount(1)
})

test('subscription resend defaults to its parent topic and menus exclude topics and active message children', async () => {
	await page.getByRole('button', { name: 'Expand all entities', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Expand all entities', exact: true }),
	).toBeEnabled()
	const dialog = await treeMenu(
		'order-events/Subscriptions/billing Dead-letter',
		'Resend dead-letter messages…',
	)
	await expect(dialog.getByLabel('Resend destination type', { exact: true })).toHaveValue('topic')
	await expect(dialog.getByLabel('Resend destination name', { exact: true })).toHaveValue(
		'order-events',
	)
	await expect(dialog).toContainText('every matching subscription')
	await expect(dialog.locator('.write-destination')).toContainText(
		'order-events/Subscriptions/billing',
	)
	await page.keyboard.press('Escape')
	for (const name of ['order-events Active', 'orders Messages']) {
		await page.getByRole('button', { name, exact: true }).click({ button: 'right' })
		await expect(
			page.getByRole('menuitem', { name: 'Resend dead-letter messages…', exact: true }),
		).toHaveCount(0)
		await page.keyboard.press('Escape')
	}
})

test('resend cancellation keeps progress visible and requires reviewing an uncertain send before another job', async () => {
	await seedDeadLetter()
	let dialog = await treeMenu('empty Active', 'Resend dead-letter messages…')
	await dialog.getByLabel('Resend destination name', { exact: true }).fill('resend-slow-send')
	await confirmResend()
	await dialog.getByRole('button', { name: 'Start resend', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Resend result' })).toContainText('sending')
	await page.keyboard.press('Escape')
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel resend', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Resend result' })).toContainText(
		'0 resends confirmed · 0 originals removed · 1 uncertain',
	)
	await expect(dialog).toContainText('may have committed')
	await expect(dialog).not.toContainText('SECRET')
	await page.keyboard.press('Escape')
	dialog = await treeMenu('empty Active', 'Resend dead-letter messages…')
	await expect(dialog).toContainText('Previous resend: unknown')
	await confirmResend()
	await expect(dialog.getByRole('button', { name: 'Start resend', exact: true })).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I have reviewed the source and destination after the uncertain result.',
			exact: true,
		})
		.check()
	await expect(dialog.getByRole('button', { name: 'Start resend', exact: true })).toBeEnabled()
	await page.keyboard.press('Escape')
	await treeMenu('empty Active', 'Peek dead-letter messages')
	await expect(
		page.locator('.message-table').getByRole('button', { name: /resend-original/ }),
	).toHaveCount(1)
})

async function startListener(
	mode: 'manual' | 'auto-complete' = 'manual',
	maximum = 1000,
	session = '',
) {
	const dialog = page.getByRole('dialog', { name: 'Background message listener', exact: true })
	await dialog.getByLabel('Listener settlement mode', { exact: true }).selectOption(mode)
	await dialog.getByLabel('Listener maximum messages', { exact: true }).fill(String(maximum))
	await dialog.getByLabel('Listener session ID', { exact: true }).fill(session)
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed the source, settlement mode and limits.',
			exact: true,
		})
		.check()
	await dialog.getByRole('button', { name: 'Start listener', exact: true }).click()
	return dialog
}
async function sendListenerFixture(id: string) {
	await select('empty Active')
	const composer = await compose(id, '{"listener":9007199254740993,"city":"Málaga"}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
}

test('background listener uses the clicked source, keeps browsing/sending available, and manually settles exact messages', async () => {
	await sendListenerFixture('listener-ui-first')
	await select('orders Active')
	await treeMenu('empty Active', 'Listen for messages…')
	const dialog = page.getByRole('dialog', { name: 'Background message listener', exact: true })
	await expect(dialog.locator('.write-destination')).toContainText('empty / Main messages')
	await expect(dialog.getByLabel('Listener settlement mode', { exact: true })).toHaveValue(
		'manual',
	)
	await expect(dialog.getByRole('button', { name: 'Start listener', exact: true })).toBeDisabled()
	await startListener()
	const first = dialog.getByRole('article', {
		name: 'Listener message listener-ui-first',
		exact: true,
	})
	await expect(first).toContainText('active')
	await first.getByRole('button', { name: 'Inspect listener message', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Inspect listener message', exact: true })
	await expect(inspector.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true',
	)
	await expect(
		inspector.getByRole('button', { name: 'Resize dialog', exact: true }),
	).toBeVisible()
	await expect(inspector.getByTestId('message-body')).toContainText('9007199254740993')
	await expect(inspector.getByTestId('message-body')).toContainText('Málaga')
	await page.keyboard.press('Escape')
	await page.screenshot({ path: 'test-results/listener-manual.png' })
	await page.keyboard.press('Escape')
	await sendListenerFixture('listener-ui-second')
	await peek()
	await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(2)
	await page.getByRole('button', { name: 'View listener', exact: true }).click()
	await expect(dialog.getByRole('article')).toHaveCount(1)
	await first.getByRole('button', { name: 'Complete', exact: true }).click()
	await page
		.getByRole('dialog', { name: 'Settle listener message', exact: true })
		.getByRole('button', { name: 'Confirm complete', exact: true })
		.click()
	await expect(first).toContainText('completed')
	const second = dialog.getByRole('article', {
		name: 'Listener message listener-ui-second',
		exact: true,
	})
	await expect(second).toContainText('active')
	await dialog.getByRole('button', { name: 'Stop listener', exact: true }).click()
	await expect(second).toContainText('released')
	await expect(dialog.getByRole('status')).toContainText('stopped')
	await page.keyboard.press('Escape')
	await peek()
	await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(1)
	await expect(page.locator('.message-table')).toContainText('listener-ui-second')
})

test('automatic listener completion requires acknowledgement and reports bounded confirmed counters', async () => {
	await sendListenerFixture('auto-listener')
	await page.getByRole('button', { name: 'Listen for messages', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Background message listener', exact: true })
	await dialog
		.getByLabel('Listener settlement mode', { exact: true })
		.selectOption('auto-complete')
	await expect(dialog).toContainText('Automatic completion removes received messages')
	await expect(dialog.getByRole('button', { name: 'Start listener', exact: true })).toBeDisabled()
	await startListener('auto-complete', 1)
	await expect(dialog.getByRole('status')).toContainText('Message limit reached')
	await expect(dialog.getByLabel('Listener counters')).toContainText('1 completed')
	await page.screenshot({ path: 'test-results/listener-automatic.png' })
	await page.keyboard.press('Escape')
	await peek()
	await expect(
		page.getByText('No messages returned at this sequence.', { exact: false }),
	).toBeVisible()
})

test('listener reports uncertain completions without retry and requires review before a new listener', async () => {
	await sendListenerFixture('unknown-complete')
	await page.getByRole('button', { name: 'Listen for messages', exact: true }).click()
	const dialog = await startListener('auto-complete')
	await expect(dialog.getByRole('status')).toContainText('unknown')
	await expect(dialog.getByLabel('Listener counters')).toContainText('1 uncertain')
	await expect(dialog).not.toContainText('SECRET')
	await dialog.getByRole('button', { name: 'Configure new listener', exact: true }).click()
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed the source, settlement mode and limits.',
			exact: true,
		})
		.check()
	await expect(dialog.getByRole('button', { name: 'Start listener', exact: true })).toBeDisabled()
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed the source after the previous uncertain settlement.',
			exact: true,
		})
		.check()
	await expect(dialog.getByRole('button', { name: 'Start listener', exact: true })).toBeEnabled()
})

test('listener renews a selected session, stays visible after closing its dialog, and stops from Operations', async () => {
	await select('sessions Sessions Active')
	await page.getByRole('button', { name: 'Listen for messages', exact: true }).click()
	const dialog = await startListener('manual', 1000, 'listener-renew-session')
	await expect(dialog).toContainText('Session listener-renew-session')
	await expect(dialog).toContainText('1 lock renewals')
	await page.keyboard.press('Escape')
	const job = page
		.getByRole('region', { name: 'Operations', exact: true })
		.getByRole('article')
		.filter({ hasText: 'Listener: sessions' })
	await expect(job).toContainText('running')
	await job.getByRole('button', { name: 'Cancel', exact: true }).click()
	if (await page.getByRole('button', { name: 'Show Operations log', exact: true }).count())
		await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await expect(job).toContainText('cancelled')
	await expect(page.locator('.listener-toolbar')).toContainText('stopped')
})

test('disconnect stops the listener and clears live history without automatic restart', async () => {
	await sendListenerFixture('disconnect-listener')
	await page.getByRole('button', { name: 'Listen for messages', exact: true }).click()
	const dialog = await startListener()
	await expect(
		dialog.getByRole('article', { name: 'Listener message disconnect-listener', exact: true }),
	).toBeVisible()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await expect(
		page
			.locator('.listener-toolbar')
			.getByRole('button', { name: 'Listen for messages', exact: true }),
	).toBeVisible()
	await expect(page.getByRole('button', { name: 'View listener', exact: true })).toHaveCount(0)
})

async function transferSource(subscription = false) {
	await page.locator('.entity-admin > summary').click()
	if (subscription) {
		await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
		await page
			.getByRole('button', {
				name: 'Expand subscription order-events/Subscriptions/audit',
				exact: true,
			})
			.click()
	} else await page.getByRole('button', { name: 'Expand queue orders', exact: true }).click()
	const name = subscription
		? 'order-events/Subscriptions/audit Transfer dead-letter'
		: 'orders Transfer dead-letter'
	await select(name)
	return name
}

test('transfer dead-letter tree view inspects exact bytes and keeps ordinary dead letters separate', async () => {
	const source = await transferSource()
	const row = page.locator('.message-table').getByRole('button', { name: /transfer-001/ })
	await expect(row).toBeInViewport()
	await expect(
		page.getByRole('button', { name: 'Transfer dead-letter', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await row.click()
	const inspector = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(inspector).toContainText('Transfer dead-letter · Message snapshot')
	await expect(inspector).toContainText('MaxTransferHopCountExceeded')
	await inspector.getByRole('button', { name: 'HEX', exact: true }).click()
	await expect(inspector.getByTestId('message-body')).toContainText('00 ff 41')
	await page.screenshot({ path: 'test-results/transfer-dead-letter-inspector.png' })
	await page.keyboard.press('Escape')
	await expect(row).toBeFocused()
	await select('orders Dead-letter')
	await expect(page.locator('.message-table')).toContainText('dead-receive-001')
	await expect(page.locator('.message-table')).not.toContainText('transfer-001')
	await select(source)
	await page
		.getByRole('complementary', { name: 'Entities', exact: true })
		.getByRole('button', { name: source, exact: true })
		.click({ button: 'right' })
	await expect(
		page.getByRole('menuitem', { name: 'Listen for messages…', exact: true }),
	).toHaveCount(0)
	await expect(page.getByRole('menuitem', { name: 'Purge messages…', exact: true })).toHaveCount(
		0,
	)
	await expect(
		page.getByRole('menuitem', { name: 'Resend transfer dead-letter messages…', exact: true }),
	).toBeVisible()
	await page.screenshot({ path: 'test-results/transfer-dead-letter-menu.png' })
	await page.keyboard.press('Escape')
})

test('receives and settles a transfer dead letter from a session subscription without accepting a session', async () => {
	await transferSource(true)
	await expect(page.getByLabel('Receive session ID', { exact: true })).toHaveCount(0)
	await receive()
	const item = page.getByRole('article', { name: 'Received transfer-001', exact: true })
	await expect(item).toContainText('active')
	await expect(
		item.getByRole('button', { name: 'Dead-letter received', exact: true }),
	).not.toBeVisible()
	await expect(
		item.getByRole('button', { name: 'Replay dead-letter', exact: true }),
	).toBeVisible()
	await item.getByRole('button', { name: 'Complete', exact: true }).click()
	await expect(page.getByRole('dialog')).toContainText('transfer-dead-letter')
	await confirmAction('Confirm complete')
	await expect(item).toContainText('completed')
	await peek()
	await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(0)
	await select('order-events/Subscriptions/audit Dead-letter')
	await expect(page.locator('.message-table')).toContainText('dead-receive-001')
})

for (const mode of ['keep', 'remove'] as const) {
	test(`transfer dead-letter resend ${mode} mode uses the clicked subqueue without typed confirmation`, async () => {
		const source = await transferSource(mode === 'remove')
		await select('empty Active')
		const dialog = await treeMenu(source, 'Resend transfer dead-letter messages…')
		await expect(dialog).toHaveAccessibleName('Resend transfer dead-letter messages')
		await expect(dialog.locator('.write-destination')).toContainText('/ Transfer dead-letter')
		await expect(
			dialog.getByRole('radio', {
				name: 'Keep originals in the transfer dead-letter queue',
				exact: true,
			}),
		).toBeChecked()
		await expect(dialog.getByLabel('Resend confirmation', { exact: true })).toHaveCount(0)
		await dialog.getByLabel('Resend destination type', { exact: true }).selectOption('queue')
		await dialog.getByLabel('Resend destination name', { exact: true }).fill('empty')
		if (mode === 'remove')
			await dialog
				.getByRole('radio', {
					name: 'Remove originals after successful resend',
					exact: true,
				})
				.check()
		await dialog
			.getByRole('checkbox', {
				name: 'I have reviewed the destination, message IDs and original-message behavior.',
				exact: true,
			})
			.check()
		await page.screenshot({ path: `test-results/transfer-dead-letter-resend-${mode}.png` })
		await dialog.getByRole('button', { name: 'Start resend', exact: true }).click()
		await expect(
			dialog.getByRole('region', { name: 'Resend result', exact: true }),
		).toContainText(
			`1 resends confirmed · ${mode === 'remove' ? 1 : 0} originals removed · 0 uncertain`,
		)
		await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled()
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(0)
		await select(source)
		await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(
			mode === 'keep' ? 1 : 0,
		)
		await select(source.replace('Transfer dead-letter', 'Dead-letter'))
		await expect(page.locator('.message-table')).toContainText('dead-receive-001')
		await select('empty Active')
		await peek()
		await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(1)
	})
}

test('transfer dead-letter purge confirms the displayed subqueue and refreshes its counter independently', async () => {
	await page.getByRole('button', { name: 'Namespace statistics' }).click()
	const source = await transferSource()
	await page.getByRole('button', { name: 'Refresh namespace counts', exact: true }).click()
	await expect(page.getByLabel('Transfer DLQ count', { exact: true })).toContainText('1')
	const row = page.getByRole('button', { name: 'orders Active', exact: true }).locator('..')
	await expect(row.getByTitle('Transfer dead-letter messages', { exact: true })).toHaveText(
		'1 TDLQ',
	)
	const dialog = await treeMenu(source, 'Purge transfer dead-letter messages…')
	await expect(dialog).toContainText('Transfer dead-letter queue')
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await expect(dialog.getByRole('button', { name: 'Start purge', exact: true })).toBeDisabled()
	await dialog.getByRole('checkbox', { name: /I understand/ }).check()
	await expect(dialog.getByLabel('Purge confirmation', { exact: true })).toHaveCount(0)
	await page.screenshot({ path: 'test-results/transfer-dead-letter-purge.png' })
	await dialog.getByRole('button', { name: 'Start purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Purge result' })).toContainText(
		'1 deletions confirmed',
	)
	await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(dialog).not.toBeVisible()
	await page.getByRole('button', { name: 'Refresh namespace counts', exact: true }).click()
	await expect(page.getByLabel('Transfer DLQ count', { exact: true })).toContainText('0')
	await expect(row.getByTitle('Transfer dead-letter messages', { exact: true })).toHaveCount(0)
	await select('orders Dead-letter')
	await expect(page.locator('.message-table')).toContainText('dead-receive-001')
	await select('orders Messages')
	await expect(page.locator('.message-table tbody').getByRole('button')).toHaveCount(2)
})

async function openBulkPurge() {
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk purge…', exact: true }).click()
	return page.getByRole('dialog', { name: 'Bulk purge messages', exact: true })
}
async function confirmBulkPurge() {
	const dialog = page.getByRole('dialog', { name: 'Bulk purge messages', exact: true })
	await dialog.getByRole('button', { name: 'Review selected targets', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Start bulk purge', exact: true }),
	).toBeDisabled()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed every selected subqueue and understand these deletions are permanent.',
		})
		.check()
	await expect(
		dialog.getByRole('button', { name: 'Start bulk purge', exact: true }),
	).toBeEnabled()
	return dialog
}
test('bulk purge reviews paginated queue and subscription subqueues, resets confirmation on edits and preserves unselected messages', async () => {
	const dialog = await openBulkPurge()
	await expect(
		dialog.getByRole('button', { name: 'Review selected targets', exact: true }),
	).toBeDisabled()
	await dialog.getByLabel('Select orders / Dead-letter', { exact: true }).check()
	await dialog.getByRole('button', { name: 'Load more queues for purge', exact: true }).click()
	await dialog.getByLabel('Select archive / Messages', { exact: true }).check()
	await dialog
		.getByRole('button', { name: 'Load subscriptions for order-events', exact: true })
		.click()
	await dialog
		.getByLabel('Select order-events/Subscriptions/audit / Transfer dead-letter', {
			exact: true,
		})
		.check()
	await dialog.getByLabel('Filter bulk purge entities', { exact: true }).fill('orders')
	await expect(dialog).toContainText('3 subqueues selected')
	await page.screenshot({ path: 'test-results/bulk-purge-selection.png' })
	await confirmBulkPurge()
	await expect(dialog.getByRole('table')).toContainText('order-events/Subscriptions/audit')
	await expect(dialog.getByRole('table')).toContainText('archive')
	await dialog.getByRole('button', { name: 'Change selection', exact: true }).click()
	await dialog.getByLabel('Bulk purge per-target limit', { exact: true }).fill('1')
	await dialog.getByRole('button', { name: 'Review selected targets', exact: true }).click()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await expect(
		dialog.getByRole('checkbox', {
			name: 'I reviewed every selected subqueue and understand these deletions are permanent.',
		}),
	).not.toBeChecked()
	await expect(dialog.getByLabel('Bulk purge confirmation', { exact: true })).toHaveCount(0)
	await dialog
		.getByRole('checkbox', {
			name: 'I reviewed every selected subqueue and understand these deletions are permanent.',
		})
		.check()
	await page.screenshot({ path: 'test-results/bulk-purge-review.png' })
	await dialog.getByRole('button', { name: 'Start bulk purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Bulk purge result' })
	await expect(result).toContainText('3 deletions confirmed')
	await expect(result).toContainText('3/3 targets attempted')
	await expect(result).toContainText('per-target limit')
	await page.screenshot({ path: 'test-results/bulk-purge-result.png' })
	await page.keyboard.press('Escape')
	await select('orders Active')
	await peek()
	await expect(page.getByRole('button', { name: /received-001$/, exact: false })).toBeVisible()
	await expect(page.getByRole('button', { name: /received-002$/, exact: false })).toBeVisible()
})
test('bulk purge selects only filtered loaded targets and shows unstarted rows when the overall limit is reached', async () => {
	const dialog = await openBulkPurge()
	await dialog.getByLabel('Filter bulk purge entities', { exact: true }).fill('orders')
	await dialog.getByRole('button', { name: 'Select visible main queues', exact: true }).click()
	await expect(dialog).toContainText('1 subqueues selected')
	await dialog.getByLabel('Filter bulk purge entities', { exact: true }).fill('')
	await dialog.getByLabel('Select empty / Messages', { exact: true }).check()
	await dialog.getByLabel('Bulk purge total limit', { exact: true }).fill('1')
	await confirmBulkPurge()
	await dialog.getByRole('button', { name: 'Start bulk purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Bulk purge result' })
	await expect(result).toContainText('Overall deletion limit reached')
	await expect(result).toContainText('1/2 targets attempted')
	await expect(result.getByRole('row').filter({ hasText: 'empty' })).toContainText('not started')
})
test('bulk purge shows aggregate progress, blocks dismissal while running and cancels remaining targets', async () => {
	await select('orders Active')
	for (const id of ['first', 'purge-wait-receive']) {
		const composer = await compose(id, '{"body":true}')
		await composer.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(composer).toHaveCount(0)
	}
	const dialog = await openBulkPurge()
	await dialog.getByLabel('Select orders / Messages', { exact: true }).check()
	await dialog.getByLabel('Select orders / Dead-letter', { exact: true }).check()
	await confirmBulkPurge()
	await dialog.getByRole('button', { name: 'Start bulk purge', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Bulk purge result' })
	await expect(result).toContainText('1 deletions confirmed')
	await expect(dialog.getByRole('progressbar', { name: 'Bulk purge progress' })).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Cancel bulk purge', exact: true }).click()
	await expect(result).toContainText('cancelled')
	await expect(result).toContainText('not started')
	await expect(result).toContainText('1 deletions confirmed')
	await page.screenshot({ path: 'test-results/bulk-purge-cancelled.png' })
	await page.keyboard.press('Escape')
	await peek()
	await expect(
		page.getByRole('button', { name: /purge-wait-receive/, exact: false }),
	).toBeVisible()
})
test('bulk purge preserves uncertain results on reopen and requires review before another purge', async () => {
	await select('orders Active')
	for (const id of ['unknown-complete', 'untouched']) {
		const composer = await compose(id, '{"body":true}')
		await composer.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(composer).toHaveCount(0)
	}
	const dialog = await openBulkPurge()
	await dialog.getByLabel('Select orders / Messages', { exact: true }).check()
	await dialog.getByLabel('Select orders / Dead-letter', { exact: true }).check()
	await confirmBulkPurge()
	await dialog.getByRole('button', { name: 'Start bulk purge', exact: true }).click()
	await expect(dialog.getByRole('region', { name: 'Bulk purge result' })).toContainText(
		'1 uncertain',
	)
	await expect(
		dialog.getByRole('button', { name: 'Prepare another bulk purge', exact: true }),
	).toBeDisabled()
	await page.keyboard.press('Escape')
	await openBulkPurge()
	await expect(dialog).toContainText('unknown')
	await expect(
		dialog.getByRole('button', { name: 'Prepare another bulk purge', exact: true }),
	).toBeDisabled()
	await page.screenshot({ path: 'test-results/bulk-purge-uncertain.png' })
	await dialog
		.getByRole('checkbox', {
			name: 'I inspected the affected targets and reviewed the uncertain deletion before preparing another purge.',
		})
		.check()
	await dialog.getByRole('button', { name: 'Prepare another bulk purge', exact: true }).click()
	await expect(
		dialog.getByRole('button', { name: 'Review selected targets', exact: true }),
	).toBeVisible()
	await page.keyboard.press('Escape')
	await peek()
	await expect(page.getByRole('button', { name: /untouched/, exact: false })).toBeVisible()
})
