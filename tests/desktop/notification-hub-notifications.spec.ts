import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-nh-send-'))
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
	await page.getByRole('button', { name: 'Notification Hubs', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function connect(hub = 'alerts', policy = false) {
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline test sends')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	if (policy) {
		await page.getByLabel('Directory (tenant) ID', { exact: true }).fill('fixture')
		await page
			.getByLabel('Application (client) ID', { exact: true })
			.fill('22222222-2222-4222-8222-222222222222')
	} else {
		await page.getByRole('radio', { name: 'Connection string', exact: true }).check()
		await page
			.getByLabel('Namespace connection string', { exact: true })
			.fill(
				'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Send;SharedAccessKey=OFFLINE-NH-KEY;',
			)
	}
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	if (policy) {
		await page
			.getByLabel('Notification Hubs namespace resource ID', { exact: true })
			.fill(resourceId)
		await page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }).click()
		await expect(page.getByText('Notification Hubs connected', { exact: true })).toBeVisible()
		await page
			.getByRole('button', { name: 'Notification Hub alerts', exact: true })
			.click({ button: 'right' })
		await page.getByRole('menuitem', { name: 'Test notifications…', exact: true }).click()
		await page.getByRole('button', { name: 'Load access policies', exact: true }).click()
		await page
			.getByLabel('Notification sender Send or Manage policy', { exact: true })
			.selectOption('sender')
		await page
			.getByLabel('Notification sender key slot', { exact: true })
			.selectOption('SecondaryKey')
	} else {
		await page.getByRole('button', { name: 'Test notifications…', exact: true }).click()
		await page.getByLabel('Notification sender hub name', { exact: true }).fill(hub)
	}
	await page.getByRole('button', { name: 'Connect notification sender', exact: true }).click()
	await expect(
		page.getByText(`Notification sender connected · ${hub}`, { exact: false }),
	).toBeVisible()
}
const dialog = () => page.getByRole('dialog')
async function compose(tags = 'sports') {
	await page.getByRole('button', { name: 'Compose test notification…', exact: true }).click()
	await dialog().getByLabel('Tag expression', { exact: true }).fill(tags)
}
async function submit() {
	await dialog().getByRole('checkbox').check()
	await dialog().getByRole('button', { name: 'Send test notification', exact: true }).click()
	await expect(
		dialog().getByRole('heading', { name: 'Notification send result', exact: true }),
	).toBeVisible()
}
async function closeResult() {
	await dialog().getByRole('button', { name: 'Close send result', exact: true }).click()
	await expect(dialog()).toBeHidden()
}
test('native sends use checkbox review, Boolean targeting and a modal with individual provider outcomes', async () => {
	await connect()
	await compose('sports && !muted')
	await expect(
		dialog().getByRole('button', { name: 'Send test notification', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('checkbox').check()
	await dialog()
		.getByLabel('Native notification payload', { exact: true })
		.fill('{"aps":{"alert":"Hello <script>data only</script>"}}')
	await expect(dialog().getByRole('checkbox')).not.toBeChecked()
	await submit()
	await expect(dialog().getByRole('cell', { name: 'apple-native', exact: true })).toBeVisible()
	await expect(dialog().getByRole('cell', { name: 'apple-failed', exact: true })).toHaveCount(0)
	await dialog().getByText('Sent payload and platform headers', { exact: true }).click()
	await expect(
		dialog().getByText('Hello <script>data only</script>', { exact: false }),
	).toBeVisible()
	await expect(dialog().locator('.json-key').first()).toBeVisible()
	await expect(page.locator('script').filter({ hasText: 'data only' })).toHaveCount(0)
	await mkdir('artifacts/validation-0.37.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.37.0/notification-result-light.png' })
	await closeResult()
	await compose('sports')
	await submit()
	await expect(dialog().getByRole('cell', { name: 'InvalidToken', exact: true })).toBeVisible()
	await closeResult()
	await page.getByRole('button', { name: 'Inspect send result…', exact: true }).click()
	await expect(dialog().getByRole('cell', { name: 'InvalidToken', exact: true })).toBeVisible()
})
test('sends Browser JSON through the bounded Azure test route', async () => {
	await connect()
	await compose('browser')
	await dialog().getByLabel('Notification format', { exact: true }).selectOption('browser')
	await submit()
	await expect(dialog()).toContainText('Azure reported no device outcomes')
	await dialog().getByText('Sent payload and platform headers', { exact: true }).click()
	await expect(dialog()).toContainText('Browser Web Push')
})
test('templates send named string parameters and empty targets remain explicit with fixed modal actions', async () => {
	await connect()
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await compose('news')
	await dialog().getByLabel('Notification format', { exact: true }).selectOption('template')
	await dialog().getByLabel('Parameter 1 value', { exact: true }).fill('Hello from template')
	await dialog().getByRole('button', { name: 'Add template parameter', exact: true }).click()
	await dialog().getByLabel('Parameter 2 name', { exact: true }).fill('title')
	await dialog().getByLabel('Parameter 2 value', { exact: true }).fill('Commander')
	await dialog().getByRole('checkbox').check()
	const frame = await dialog().boundingBox(),
		button = await dialog()
			.getByRole('button', { name: 'Send test notification', exact: true })
			.boundingBox()
	expect(button!.y + button!.height).toBeLessThanOrEqual(frame!.y + frame!.height)
	await mkdir('artifacts/validation-0.37.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.37.0/notification-template-dark.png' })
	await dialog().getByRole('button', { name: 'Send test notification', exact: true }).click()
	await expect(
		dialog().getByRole('heading', { name: 'Notification send result', exact: true }),
	).toBeVisible()
	await expect(dialog().getByRole('cell', { name: 'fcm-template', exact: true })).toBeVisible()
	await dialog().getByText('Sent payload and platform headers', { exact: true }).click()
	await expect(dialog().getByText('Hello from template', { exact: false })).toBeVisible()
	await closeResult()
	await compose('no-matching-tag')
	await submit()
	await expect(
		dialog().getByText('Azure reported no device outcomes.', { exact: false }),
	).toBeVisible()
})
test('native FCM v1 and broadcast targeting require a fresh acknowledgment', async () => {
	await connect()
	await compose('news')
	await dialog().getByLabel('Notification format', { exact: true }).selectOption('FcmV1')
	await dialog().getByRole('checkbox').check()
	await dialog().getByLabel('Notification target', { exact: true }).selectOption('broadcast')
	await expect(dialog().getByRole('checkbox')).not.toBeChecked()
	await expect(dialog().getByLabel('Tag expression', { exact: true })).toHaveCount(0)
	await submit()
	await expect(dialog().getByRole('cell', { name: 'fcm-template', exact: true })).toBeVisible()
})
test('unknown send receipts block subsequent sends until review and recovery never resends', async () => {
	await connect('send-uncertain')
	await compose()
	await submit()
	await expect(
		dialog().getByText('Azure may have accepted this test send.', { exact: false }),
	).toBeVisible()
	await closeResult()
	await expect(
		page.getByRole('button', { name: 'Compose test notification…', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Check test send receipt', exact: true }).click()
	await expect(page.getByText('Last test send · unknown', { exact: true })).toBeVisible()
	await page
		.getByRole('checkbox', { name: 'I reviewed the uncertain outcome', exact: false })
		.check()
	await expect(
		page.getByRole('button', { name: 'Compose test notification…', exact: true }),
	).toBeEnabled()
})
test('cancels an in-flight test send and retains truthful uncertain results', async () => {
	await connect('send-slow')
	await compose()
	await dialog().getByRole('checkbox').check()
	await dialog().getByRole('button', { name: 'Send test notification', exact: true }).click()
	await expect(dialog().getByText('Sending…', { exact: true })).toBeVisible()
	await dialog()
		.getByRole('button', { name: 'Cancel notification operation', exact: true })
		.click()
	await expect(
		dialog().getByRole('heading', { name: 'Notification send result', exact: true }),
	).toBeVisible()
	await expect(
		dialog().getByText('Azure may have accepted this test send.', { exact: false }),
	).toBeVisible()
})
test('rejects malformed payloads, invalid tag expressions and duplicate template names before sending', async () => {
	await connect()
	await compose('news ||')
	await dialog().getByRole('checkbox').check()
	await expect(
		dialog().getByRole('button', { name: 'Send test notification', exact: true }),
	).toBeDisabled()
	await dialog().getByLabel('Tag expression', { exact: true }).fill('news')
	await dialog().getByLabel('Native notification payload', { exact: true }).fill('[]')
	await dialog().getByRole('checkbox').check()
	await expect(
		dialog().getByRole('button', { name: 'Send test notification', exact: true }),
	).toBeDisabled()
	await dialog().getByLabel('Notification format', { exact: true }).selectOption('template')
	await dialog().getByRole('button', { name: 'Add template parameter', exact: true }).click()
	await dialog().getByLabel('Parameter 2 name', { exact: true }).fill('MESSAGE')
	await dialog().getByLabel('Parameter 2 value', { exact: true }).fill('duplicate')
	await dialog().getByRole('checkbox').check()
	await expect(
		dialog().getByRole('button', { name: 'Send test notification', exact: true }),
	).toBeDisabled()
	await expect(dialog().getByRole('alert')).toContainText('unique template')
})
test('hub context menu connects with an explicitly selected Send-only ARM policy', async () => {
	await connect('alerts', true)
	await compose()
	await submit()
	await expect(dialog().getByRole('cell', { name: 'InvalidToken', exact: true })).toBeVisible()
})
test('an acknowledged send retains its status when detailed Azure outcomes cannot be read', async () => {
	await connect('send-malformed')
	await compose()
	await submit()
	await expect(
		dialog().getByText(
			'Azure acknowledged the test send, but detailed outcomes were unavailable',
			{
				exact: false,
			},
		),
	).toBeVisible()
	await expect(dialog().getByText('confirmed ·', { exact: false })).toBeVisible()
})
