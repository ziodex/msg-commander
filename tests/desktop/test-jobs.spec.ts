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
async function openJob(entity = 'empty', mode = 'send') {
	await page
		.getByRole('button', {
			name: `${entity}${entity === 'sessions' ? ' Sessions' : ''} Active`,
			exact: true,
		})
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: `Run ${mode} test…`, exact: true }).click()
	return page.getByRole('dialog')
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.24.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.24.0/${name}.png` })
}
test('configures and sends a counted test job, resets acknowledgement on edits and retains the result', async () => {
	const dialog = await openJob()
	await expect(dialog).toContainText('empty · Send messages')
	const start = dialog.getByRole('button', { name: 'Start test job', exact: true })
	const ack = dialog.getByRole('checkbox', { name: /I understand this sends/ })
	await expect(start).toBeDisabled()
	await dialog.getByLabel('Test message count', { exact: true }).fill('3')
	await dialog.getByLabel('Test message body', { exact: true }).fill('{"hello":"world"}')
	await ack.check()
	await dialog.getByLabel('Test message delay', { exact: true }).fill('50')
	await expect(ack).not.toBeChecked()
	await dialog.getByLabel('Test message count', { exact: true }).fill('100001')
	await ack.check()
	await expect(start).toBeDisabled()
	await dialog.getByLabel('Test message count', { exact: true }).fill('3')
	await ack.check()
	await screenshot('test-job-send-setup')
	await start.click()
	const result = dialog.getByRole('region', { name: 'Test job result', exact: true })
	await expect(result).toContainText('3 sends confirmed. Message target reached.')
	await expect(dialog.getByRole('progressbar')).toHaveAttribute('value', '3')
	await screenshot('test-job-send-result')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'empty Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table tbody tr')).toHaveCount(3)
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Test job result', exact: true }).click()
	await expect(result).toContainText('3 sends confirmed')
})

test('runs worker batches and shows latency samples and per-worker totals', async () => {
	const dialog = await openJob()
	await dialog.getByLabel('Test workers', { exact: true }).fill('3')
	await dialog.getByLabel('Test batch size', { exact: true }).fill('4')
	await dialog.getByLabel('Test message count', { exact: true }).fill('13')
	const ack = dialog.getByRole('checkbox', { name: /I understand this sends/ })
	await ack.check()
	await dialog.getByLabel('Test workers', { exact: true }).fill('2')
	await expect(ack).not.toBeChecked()
	await ack.check()
	await dialog.getByLabel('Test batch size', { exact: true }).fill('3')
	await expect(ack).not.toBeChecked()
	await dialog.getByLabel('Test workers', { exact: true }).fill('3')
	await dialog.getByLabel('Test batch size', { exact: true }).fill('4')
	await ack.check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('13 sends confirmed')
	await expect(dialog).toContainText('4 batches confirmed')
	const table = dialog.getByRole('table', { name: 'Operation latency', exact: true })
	await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('4')
	await expect(table.getByRole('columnheader', { name: 'p95', exact: true })).toBeVisible()
	await dialog.getByText('Worker details', { exact: true }).click()
	await expect(
		dialog.getByRole('table', { name: 'Test worker results', exact: true }).locator('tbody tr'),
	).toHaveCount(3)
	await screenshot('test-job-workers-latency')
})

test('previews indexed JSON and seeded bytes without sending until acknowledged', async () => {
	const dialog = await openJob()
	await dialog.getByLabel('Test payload generator', { exact: true }).selectOption('json-template')
	await dialog.getByRole('button', { name: 'Use example', exact: true }).click()
	await dialog.getByLabel('Test generator seed', { exact: true }).fill('42')
	await dialog.getByRole('button', { name: 'Preview payload', exact: true }).click()
	const preview = dialog.getByRole('region', { name: 'Test payload preview', exact: true })
	await expect(preview).toContainText('"index": 1')
	await expect(preview).toContainText('application/json')
	await expect(dialog.getByRole('button', { name: 'Start test job', exact: true })).toBeDisabled()
	await dialog.getByLabel('Test generator seed', { exact: true }).fill('7')
	await expect(preview).toHaveCount(0)
	await dialog.getByLabel('Test payload generator', { exact: true }).selectOption('binary')
	await dialog.getByLabel('Test payload bytes', { exact: true }).fill('1025')
	await dialog.getByRole('button', { name: 'Preview payload', exact: true }).click()
	await expect(preview).toContainText('1025 bytes')
	await expect(preview).toContainText('application/octet-stream')
	await dialog.getByLabel('Test message count', { exact: true }).fill('3')
	await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('3 sends confirmed')
	await expect(
		dialog.getByRole('button', { name: 'Prepare another test job', exact: true }),
	).toBeEnabled()
})

test('reviews a dead-letter reason and reports the selected settlement with its latency', async () => {
	const dialog = await openJob('orders', 'receive')
	await dialog.getByRole('checkbox', { name: /I understand this permanently completes/ }).check()
	await dialog.getByLabel('Test settlement mode', { exact: true }).selectOption('dead-letter')
	const ack = dialog.getByRole('checkbox', { name: /I understand this moves messages/ })
	await expect(ack).not.toBeChecked()
	await dialog.getByLabel('Test message count', { exact: true }).fill('1')
	await dialog.getByLabel('Test dead-letter reason', { exact: true }).fill('')
	await ack.check()
	await expect(dialog.getByRole('button', { name: 'Start test job', exact: true })).toBeDisabled()
	await dialog.getByLabel('Test dead-letter reason', { exact: true }).fill('BetaReview')
	await expect(ack).not.toBeChecked()
	await ack.check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('1 dead-letters confirmed')
	await expect(
		dialog
			.getByRole('table', { name: 'Operation latency', exact: true })
			.getByRole('rowheader', { name: 'Dead-letter', exact: true }),
	).toBeVisible()
})

test('keeps exact deferred sequences and bounds the defer test count', async () => {
	const dialog = await openJob('orders', 'receive')
	await dialog.getByLabel('Test settlement mode', { exact: true }).selectOption('defer')
	await dialog.getByLabel('Test message count', { exact: true }).fill('1001')
	const ack = dialog.getByRole('checkbox', { name: /I understand this defers/ })
	await ack.check()
	await expect(dialog.getByRole('button', { name: 'Start test job', exact: true })).toBeDisabled()
	await dialog.getByLabel('Test message count', { exact: true }).fill('2')
	await ack.check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('2 deferrals confirmed')
	await dialog.getByText('Deferred sequences (2)', { exact: true }).click()
	await expect(dialog.getByLabel('Test deferred sequences', { exact: true })).toHaveValue(
		/^\d+\n\d+$/,
	)
	await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
	await expect(dialog.getByLabel('Test job type', { exact: true })).toHaveValue('receive')
	await expect(dialog.getByLabel('Test settlement mode', { exact: true })).toHaveValue('defer')
})
test('receives and completes existing queue messages with explicit acknowledgement and a count bound', async () => {
	const dialog = await openJob('orders', 'receive')
	await expect(dialog).toContainText('including existing messages from other applications')
	await expect(dialog.getByLabel('Test message body', { exact: true })).toHaveCount(0)
	await dialog.getByLabel('Test message count', { exact: true }).fill('1')
	const start = dialog.getByRole('button', { name: 'Start test job', exact: true })
	await expect(start).toBeDisabled()
	await dialog.getByRole('checkbox', { name: /I understand this permanently completes/ }).check()
	await screenshot('test-job-receive-setup')
	await start.click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('1 received; 1 completions confirmed.')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table tbody tr')).toHaveCount(1)
})
test('reports progress and cancels a paced send with a partial receipt and no accidental restart', async () => {
	const dialog = await openJob()
	await dialog.getByLabel('Test message count', { exact: true }).fill('100')
	await dialog.getByLabel('Test message delay', { exact: true }).fill('500')
	await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(dialog.getByRole('progressbar')).not.toHaveAttribute('value', '0')
	await page.keyboard.press('Escape')
	await expect(dialog).toBeVisible()
	await screenshot('test-job-running')
	await dialog.getByRole('button', { name: 'Cancel test job', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Test job result', exact: true })
	await expect(result).toContainText('Cancelled.')
	const count = Number(await dialog.getByRole('progressbar').getAttribute('value'))
	expect(count).toBeGreaterThan(0)
	expect(count).toBeLessThan(100)
	await screenshot('test-job-cancelled')
	await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
	await expect(dialog.getByRole('button', { name: 'Start test job', exact: true })).toBeDisabled()
})
test('idle receive reaches its time limit and session errors preserve a zero-write receipt', async () => {
	const dialog = await openJob('empty', 'receive')
	await dialog.getByLabel('Test time limit', { exact: true }).fill('1')
	await dialog.getByRole('checkbox', { name: /I understand this permanently completes/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('0 received; 0 completions confirmed. Time limit reached.')
	await page.keyboard.press('Escape')
	await openJob('sessions', 'receive')
	await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
	await expect(dialog).toContainText('sessions · Receive & complete')
	await dialog.getByRole('checkbox', { name: /I understand this permanently completes/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('Enter a session ID')
})
test('topic and subscription tree menus launch compatible job types with a fixed target', async () => {
	await page.getByRole('button', { name: 'Topics', exact: true }).click()
	const dialog = await openJob('order-events', 'send')
	await expect(dialog.getByLabel('Test job type', { exact: true })).toHaveCount(0)
	await dialog.getByLabel('Test message count', { exact: true }).fill('3')
	await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('3 sends confirmed')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
	await openJob('billing', 'receive')
	await dialog.getByRole('button', { name: 'Prepare another test job', exact: true }).click()
	await expect(dialog).toContainText('order-events/Subscriptions/billing')
	await expect(dialog.getByLabel('Test job type', { exact: true })).toHaveCount(0)
	await dialog.getByLabel('Test message count', { exact: true }).fill('2')
	await dialog.getByRole('checkbox', { name: /I understand this permanently completes/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	await expect(
		dialog.getByRole('region', { name: 'Test job result', exact: true }),
	).toContainText('2 received; 2 completions confirmed.')
})

test('shows an uncertain send receipt and requires review before another job', async () => {
	await page.getByRole('button', { name: 'Queues', exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Create queue…', exact: true }).click()
	const create = page.getByRole('dialog')
	await create.getByLabel('Entity name', { exact: true }).fill('resend-unknown-send')
	await create.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(create).toHaveCount(0)
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Test jobs…', exact: true }).click()
	const dialog = page.getByRole('dialog')
	await dialog.getByRole('checkbox', { name: /I understand this sends/ }).check()
	await dialog.getByRole('button', { name: 'Start test job', exact: true }).click()
	const result = dialog.getByRole('region', { name: 'Test job result', exact: true })
	await expect(result).toContainText('0 sends confirmed')
	await expect(result).toContainText('The last send is uncertain')
	await expect(result).not.toContainText('SECRET')
	const another = dialog.getByRole('button', { name: 'Prepare another test job', exact: true })
	await expect(another).toBeDisabled()
	await screenshot('test-job-unknown')
	await dialog.getByRole('checkbox', { name: /I have reviewed this result/ }).check()
	await expect(another).toBeEnabled()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table tbody tr')).toHaveCount(1)
})
