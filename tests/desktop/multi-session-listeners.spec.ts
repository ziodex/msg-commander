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
const dialog = () => page.getByRole('dialog', { name: 'Background message listener', exact: true })
async function open() {
	await page
		.getByRole('button', { name: 'sessions Sessions Active', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Listen for messages…', exact: true }).click()
	await dialog().getByLabel('Listener session selection').selectOption('next-available')
}
async function send(id: string, session: string) {
	await page.getByRole('button', { name: 'sessions Sessions Active', exact: true }).click()
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	const composer = page.getByRole('dialog')
	await composer.getByLabel('Message ID', { exact: true }).fill(id)
	await composer.getByLabel('Send session ID', { exact: true }).fill(session)
	await composer.getByLabel('Message body', { exact: true }).fill('{"exact":9007199254740993}')
	await composer.getByRole('button', { name: 'Send message', exact: true }).click()
	await expect(composer).toHaveCount(0)
}
async function confirm() {
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed the source, settlement mode and limits.',
			exact: true,
		})
		.check()
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.21.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.21.0/${name}.png` })
}
test('validates concurrency, resets acknowledgement and displays manual progress for two independent sessions', async () => {
	await send('session-a-message', 'a')
	await send('session-b-message', 'b')
	await open()
	const run = dialog().getByRole('button', { name: 'Start listener', exact: true })
	await expect(dialog().getByLabel('Listener settlement mode')).toHaveValue('manual')
	await expect(dialog().getByLabel('Listener session ID', { exact: true })).toHaveCount(0)
	await confirm()
	await dialog().getByLabel('Listener concurrent sessions').fill('9')
	await expect(run).toBeDisabled()
	await expect(
		dialog().getByRole('checkbox', { name: /I reviewed the source, settlement/ }),
	).not.toBeChecked()
	await dialog().getByLabel('Listener concurrent sessions').fill('2')
	await dialog().getByLabel('Listener maximum messages').fill('2')
	await confirm()
	await screenshot('multi-session-configuration')
	await run.click()
	const progress = dialog().getByRole('region', { name: 'Session progress' })
	await expect(progress).toContainText('2 / 2 sessions owned')
	await expect(progress.getByRole('row', { name: 'Session a', exact: true })).toContainText(
		'waiting',
	)
	await expect(progress.getByRole('row', { name: 'Session b', exact: true })).toContainText(
		'waiting',
	)
	await screenshot('multi-session-progress')
	const first = dialog().getByRole('article', {
		name: 'Listener message session-a-message',
		exact: true,
	})
	await first.getByRole('button', { name: 'Inspect listener message', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Inspect listener message', exact: true })
	await expect(inspector.getByTestId('message-body')).toContainText('9007199254740993')
	await inspector.getByRole('button', { name: 'Close', exact: true }).click()
	await first.getByRole('button', { name: 'Complete', exact: true }).click()
	const settlement = page.getByRole('dialog', { name: 'Settle listener message', exact: true })
	await expect(settlement).toContainText('Session a')
	await settlement.getByRole('button', { name: 'Confirm complete', exact: true }).click()
	await expect(first).toContainText('completed')
	await expect(
		dialog().getByRole('article', { name: 'Listener message session-b-message', exact: true }),
	).toContainText('active')
	await dialog().getByRole('button', { name: 'Stop listener', exact: true }).click()
	await expect(dialog().getByRole('status').first()).toContainText('Shared message limit reached')
	await expect(progress).toContainText('0 / 2 sessions owned')
})
test('automatic completion requires acknowledgement and uses the whole-job message limit', async () => {
	await send('automatic-a', 'a')
	await send('automatic-b', 'b')
	await open()
	await dialog().getByLabel('Listener settlement mode').selectOption('auto-complete')
	await dialog().getByLabel('Listener maximum messages').fill('1')
	await expect(dialog()).toContainText('Automatic completion removes received messages')
	await expect(
		dialog().getByRole('button', { name: 'Start listener', exact: true }),
	).toBeDisabled()
	await confirm()
	await dialog().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(dialog().getByRole('status').first()).toContainText('Shared message limit reached')
	await expect(dialog().getByRole('region', { name: 'Session progress' })).toContainText(
		'1 / 1 messages',
	)
	await expect(dialog().getByRole('article')).toHaveCount(1)
	await expect(dialog().getByRole('article')).toContainText('completed')
})
test('closing the dialog preserves the listener and stopping it releases all session rows', async () => {
	await send('pending-a', 'a')
	await send('pending-b', 'b')
	await open()
	await confirm()
	await dialog().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(dialog().getByRole('region', { name: 'Session progress' })).toContainText(
		'2 / 2 sessions owned',
	)
	await dialog().getByRole('button', { name: 'Close', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await expect(page.locator('.listener-toolbar')).toContainText('sessions')
	await page.getByRole('button', { name: 'View listener', exact: true }).click()
	await expect(dialog().locator('.write-destination')).toContainText('sessions')
	await dialog().getByRole('button', { name: 'Stop listener', exact: true }).click()
	await expect(dialog().getByRole('status').first()).toContainText('stopped')
	await expect(dialog().getByRole('region', { name: 'Session progress' })).toContainText(
		'0 / 2 sessions owned',
	)
	await expect(dialog().getByRole('article').first()).toContainText('released')
})
test('time limit ends manual review and releases every session without completing', async () => {
	await send('timed-a', 'a')
	await send('timed-b', 'b')
	await open()
	await dialog().getByLabel('Listener run time').fill('2')
	await confirm()
	await dialog().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(dialog().getByRole('status').first()).toContainText('Time limit reached')
	await expect(dialog().getByRole('region', { name: 'Session progress' })).toContainText(
		'0 / 2 sessions owned',
	)
	for (const id of ['timed-a', 'timed-b'])
		await expect(
			dialog().getByRole('article', { name: `Listener message ${id}`, exact: true }),
		).toContainText('released')
})
test('cancelled parallel settlements show per-session uncertainty and require review before restart', async () => {
	await send('purge-wait-complete', 'a')
	await send('purge-wait-complete', 'b')
	await open()
	await dialog().getByLabel('Listener settlement mode').selectOption('auto-complete')
	await confirm()
	await dialog().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(dialog().getByRole('article')).toHaveCount(2)
	await expect(dialog().getByRole('article').nth(1)).toContainText('settling')
	await dialog().getByRole('button', { name: 'Stop listener', exact: true }).click()
	await expect(dialog().getByRole('status').first()).toContainText('unknown')
	const progress = dialog().getByRole('region', { name: 'Session progress' })
	await expect(progress.getByRole('row', { name: 'Session a', exact: true })).toContainText(
		'unknown',
	)
	await expect(progress.getByRole('row', { name: 'Session b', exact: true })).toContainText(
		'unknown',
	)
	await screenshot('multi-session-uncertain')
	await dialog().getByRole('button', { name: 'Configure new listener' }).click()
	await confirm()
	await expect(
		dialog().getByRole('button', { name: 'Start listener', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed the source after the previous uncertain settlement.',
			exact: true,
		})
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Start listener', exact: true }),
	).toBeEnabled()
})
