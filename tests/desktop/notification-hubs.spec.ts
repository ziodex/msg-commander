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
	directory = await mkdtemp(join(tmpdir(), 'commander-nh-'))
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
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline Notification Hubs')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page.getByLabel('Directory (tenant) ID', { exact: true }).fill('fixture')
	await page
		.getByLabel('Application (client) ID', { exact: true })
		.fill('22222222-2222-4222-8222-222222222222')
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function connect(tenant = 'fixture') {
	await page
		.getByLabel('Notification Hubs namespace resource ID', { exact: true })
		.fill(resourceId)
	await page.getByLabel('Notification Hubs management tenant', { exact: true }).fill(tenant)
	await page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }).click()
	if (tenant === 'fixture')
		await expect(page.getByText('Notification Hubs connected', { exact: true })).toBeVisible()
}
const dialog = () => page.getByRole('dialog')
async function submit(name: string) {
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this/ })
		.check()
	await dialog().getByRole('button', { name, exact: true }).click()
	await expect(
		dialog().getByRole('button', { name: 'Close Notification Hubs result' }),
	).toBeEnabled()
}
async function closeResult() {
	await dialog().getByRole('button', { name: 'Close Notification Hubs result' }).click()
}
async function menu(node: string, action: string) {
	await page.getByRole('button', { name: node, exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
test('browses hubs, pages, refreshes from menus and toggles the tree', async () => {
	await connect()
	await expect(
		page.getByRole('button', { name: 'Notification Hub alerts', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Load more hubs', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Notification Hub more-alerts', exact: true }),
	).toBeVisible()
	await menu('Notification Hub alerts', 'Refresh status')
	await expect(page.getByRole('row', { name: 'Policy alerts-reader' })).toBeVisible()
	await expect(page.getByText('fixture', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Notification Hub alerts', exact: true }),
	).toBeHidden()
	await page.getByRole('button', { name: 'Expand all', exact: true }).click()
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Notification Hubs resources' })).toBeHidden()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect(
		page.getByRole('navigation', { name: 'Notification Hubs resources' }),
	).toBeVisible()
	await mkdir('artifacts/validation-0.34.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.34.0/notification-hubs-tree.png' })
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await expect
		.poll(() =>
			page
				.getByRole('button', { name: 'Disconnect Notification Hubs', exact: true })
				.evaluate((el) => getComputedStyle(el).color),
		)
		.toBe('rgb(238, 233, 224)')
	await page.screenshot({ path: 'artifacts/validation-0.34.0/notification-hubs-dark.png' })
})
test('creates, edits lifetime and tags, and deletes a hub with checkbox review', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Notification Hub', exact: true }).click()
	await dialog().getByLabel('Hub name', { exact: true }).fill('team/new-alerts')
	await dialog().getByLabel('Registration lifetime', { exact: true }).fill('90.00:00:00')
	await dialog().getByRole('button', { name: 'Add tag', exact: true }).click()
	await dialog().getByLabel('Tag name', { exact: true }).fill('environment')
	await dialog().getByLabel('Tag value', { exact: true }).fill('test')
	await mkdir('artifacts/validation-0.34.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.34.0/notification-hubs-create.png' })
	await expect(
		dialog().getByRole('button', { name: 'Create Notification Hub', exact: true }),
	).toBeDisabled()
	await submit('Create Notification Hub')
	await closeResult()
	await page.getByRole('button', { name: 'Load more hubs', exact: true }).click()
	const node = 'Notification Hub team/new-alerts'
	await menu(node, 'Edit hub…')
	await expect(dialog().getByLabel('Registration lifetime', { exact: true })).toHaveValue(
		'90.00:00:00',
	)
	await expect(dialog().getByLabel('Tag value', { exact: true })).toHaveValue('test')
	await dialog().getByLabel('Registration lifetime', { exact: true }).fill('30.00:00:00')
	await dialog().getByLabel('Tag value', { exact: true }).fill('updated')
	await submit('Edit Notification Hub')
	await closeResult()
	await page.getByRole('button', { name: 'Load more hubs', exact: true }).click()
	await menu(node, 'Refresh status')
	await expect(page.getByText('30.00:00:00', { exact: true })).toBeVisible()
	await expect(page.getByText('updated', { exact: true })).toBeVisible()
	await menu(node, 'Delete hub…')
	await expect(dialog().locator('input[type=text]')).toHaveCount(0)
	await submit('Delete Notification Hub')
	await closeResult()
	await page.getByRole('button', { name: 'Load more hubs', exact: true }).click()
	await expect(page.getByRole('button', { name: node, exact: true })).toBeHidden()
})
test('creates a policy, reveals one slot, rotates it and hides secrets when closing', async () => {
	await connect()
	await page.getByRole('button', { name: 'Notification Hub alerts', exact: true }).click()
	await page.getByRole('button', { name: 'Create SAS policy', exact: true }).click()
	await dialog().getByLabel('Policy name', { exact: true }).fill('new-policy')
	await dialog().getByRole('checkbox', { name: 'Send', exact: true }).check()
	await submit('Create SAS policy')
	await closeResult()
	const row = page.getByRole('row', { name: 'Policy new-policy', exact: true })
	await row.getByRole('button', { name: 'Keys', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveCount(0)
	await dialog().getByRole('button', { name: 'Reveal key', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveValue(
		'OFFLINE-NH-PRIMARY-1',
	)
	await dialog().getByRole('button', { name: 'Copy connection string', exact: true }).click()
	expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
		'EntityPath=alerts',
	)
	await app.evaluate(({ clipboard }) => clipboard.clear())
	await dialog().getByRole('button', { name: 'Close keys', exact: true }).click()
	await row.getByRole('button', { name: 'Regenerate', exact: true }).click()
	await submit('Regenerate key for SAS policy')
	await closeResult()
	await row.getByRole('button', { name: 'Keys', exact: true }).click()
	await dialog().getByRole('button', { name: 'Reveal key', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveValue(
		'OFFLINE-NH-PRIMARY-2',
	)
	await dialog().getByLabel('Key slot', { exact: true }).selectOption('SecondaryKey')
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveCount(0)
	await dialog().getByRole('button', { name: 'Reveal key', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveValue(
		'OFFLINE-NH-SECONDARY-1',
	)
	await dialog().getByRole('button', { name: 'Close keys', exact: true }).click()
	expect(await page.locator('body').innerText()).not.toContain('OFFLINE-NH-PRIMARY')
	await row.getByRole('button', { name: 'Delete', exact: true }).click()
	await submit('Delete SAS policy')
	await closeResult()
	await expect(row).toHaveCount(0)
})
test('blocks further changes after a lost write response until receipt/state review', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Notification Hub', exact: true }).click()
	await dialog().getByLabel('Hub name', { exact: true }).fill('unknown-create')
	await submit('Create Notification Hub')
	await expect(dialog().getByRole('status')).toContainText('may have accepted')
	await closeResult()
	await expect(
		page.getByRole('button', { name: 'Create Notification Hub', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Check retained receipt', exact: true }).click()
	await expect(
		page.getByText('Last Notification Hubs change · unknown', { exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Refresh namespace', exact: true }).click()
	await page.getByRole('button', { name: 'Load more hubs', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Notification Hub unknown-create', exact: true }),
	).toBeVisible()
	await page
		.getByRole('checkbox', {
			name: 'I checked Azure state and reviewed the uncertain outcome before another change.',
		})
		.check()
	await expect(
		page.getByRole('button', { name: 'Create Notification Hub', exact: true }),
	).toBeEnabled()
})
test('cancels management login and explains denied access without leaking exceptions', async () => {
	await connect('slow')
	await expect(page.getByText('OFFLINE-NH', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: 'Cancel Notification Hubs operation', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }),
	).toBeEnabled()
	await connect('denied')
	await expect(page.locator('.nh-explorer [role=alert]')).toContainText(
		'Notification Hubs management access denied',
	)
	expect(await page.locator('body').innerText()).not.toContain('SECRET')
})

test('edits namespace policy rights, copies its secondary key and protects the root rule', async () => {
	await connect()
	const root = page.getByRole('row', { name: 'Policy RootManageSharedAccessKey', exact: true })
	await expect(root.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
	const sender = page.getByRole('row', { name: 'Policy sender', exact: true })
	await sender.getByRole('button', { name: 'Edit', exact: true }).click()
	await expect(dialog().getByRole('checkbox', { name: 'Send', exact: true })).toBeChecked()
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this/ })
		.check()
	await dialog().getByRole('checkbox', { name: 'Manage', exact: true }).check()
	await expect(dialog().getByRole('checkbox', { name: /I reviewed this/ })).not.toBeChecked()
	await expect(dialog().getByRole('checkbox', { name: 'Listen', exact: true })).toBeChecked()
	await submit('Edit SAS policy')
	await closeResult()
	await expect(sender).toContainText('Manage')
	await sender.getByRole('button', { name: 'Keys', exact: true }).click()
	await dialog().getByLabel('Key slot', { exact: true }).selectOption('SecondaryKey')
	await dialog().getByRole('button', { name: 'Copy connection string', exact: true }).click()
	const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
	expect(copied).toContain('OFFLINE-NH-SECONDARY-1')
	expect(copied).not.toContain('EntityPath')
	await app.evaluate(({ clipboard }) => clipboard.clear())
	await dialog().getByRole('button', { name: 'Close keys', exact: true }).click()
	await sender.getByRole('button', { name: 'Delete', exact: true }).click()
	await expect(dialog().locator('input[type=text]')).toHaveCount(0)
	await submit('Delete SAS policy')
	await closeResult()
	await expect(sender).toHaveCount(0)
})
