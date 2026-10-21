import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Relay/namespaces/fixture'
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-relay-'))
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
	await page.getByRole('button', { name: 'Relay', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline Relay')
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
	await page.getByLabel('Relay namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByLabel('Relay management tenant', { exact: true }).fill(tenant)
	await page.getByRole('button', { name: 'Connect Relay', exact: true }).click()
	if (tenant === 'fixture')
		await expect(page.getByText('Relay connected', { exact: true })).toBeVisible()
}
const dialog = () => page.getByRole('dialog')
async function submit(name: string) {
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this/ })
		.check()
	await dialog().getByRole('button', { name, exact: true }).click()
	await expect(dialog().getByRole('button', { name: 'Close Relay result' })).toBeEnabled()
}
async function closeResult() {
	await dialog().getByRole('button', { name: 'Close Relay result' }).click()
}
async function menu(node: string, action: string) {
	await page.getByRole('button', { name: node, exact: true }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
test('browses both resource families, pages, refreshes from menus and toggles the tree', async () => {
	await connect()
	await expect(
		page.getByRole('button', { name: 'Hybrid Connection bridge', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Hybrid Connection more-bridge', exact: true }),
	).toBeVisible()
	await menu('Hybrid Connection bridge', 'Refresh status')
	await expect(page.getByText('Fixture Hybrid Connection', { exact: true })).toBeVisible()
	await expect(page.getByRole('row', { name: 'Policy bridge-reader' })).toBeVisible()
	await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Hybrid Connection bridge', exact: true }),
	).toBeHidden()
	await page.getByRole('button', { name: 'Expand all', exact: true }).click()
	await page.getByRole('button', { name: 'WCF Relay legacy', exact: true }).click()
	await expect(page.getByText('NetTcp', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Relay resources' })).toBeHidden()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect(page.getByRole('navigation', { name: 'Relay resources' })).toBeVisible()
	await mkdir('artifacts/validation-0.31.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.31.0/relay-tree.png' })
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await expect
		.poll(() =>
			page
				.getByRole('button', { name: 'Disconnect Relay', exact: true })
				.evaluate((el) => getComputedStyle(el).color),
		)
		.toBe('rgb(238, 233, 224)')
	await page.screenshot({ path: 'artifacts/validation-0.31.0/relay-dark.png' })
})
test('creates, edits and deletes a Hybrid Connection with checkbox review', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }).click()
	await dialog().getByLabel('Resource name', { exact: true }).fill('team/new-bridge')
	await dialog().getByLabel('Metadata', { exact: true }).fill('First metadata')
	await mkdir('artifacts/validation-0.31.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.31.0/relay-create.png' })
	await expect(
		dialog().getByRole('button', { name: 'Create Hybrid Connection', exact: true }),
	).toBeDisabled()
	await submit('Create Hybrid Connection')
	await closeResult()
	// The new entity is beyond the first page.
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await menu('Hybrid Connection team/new-bridge', 'Edit resource…')
	await expect(dialog().getByLabel('Metadata', { exact: true })).toHaveValue('First metadata')
	await dialog().getByLabel('Metadata', { exact: true }).fill('Updated metadata')
	await submit('Edit Hybrid Connection')
	await closeResult()
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await menu('Hybrid Connection team/new-bridge', 'Refresh status')
	await expect(page.getByText('Updated metadata', { exact: true })).toBeVisible()
	await menu('Hybrid Connection team/new-bridge', 'Copy endpoint')
	expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
		'https://fixture.servicebus.windows.net/team/new-bridge',
	)
	await app.evaluate(({ clipboard }) => clipboard.clear())
	await menu('Hybrid Connection team/new-bridge', 'Delete resource…')
	await expect(dialog().locator('input[type=text]')).toHaveCount(0)
	await submit('Delete Hybrid Connection')
	await closeResult()
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Hybrid Connection team/new-bridge', exact: true }),
	).toBeHidden()
})
test('manages WCF settings while keeping testing explicitly excluded', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create WCF Relay', exact: true }).click()
	await dialog().getByLabel('Resource name', { exact: true }).fill('new-wcf')
	await dialog().getByLabel('Relay type', { exact: true }).selectOption('NetTcp')
	await submit('Create WCF Relay')
	await closeResult()
	await menu('WCF Relay new-wcf', 'Edit resource…')
	await expect(dialog().getByLabel('Relay type', { exact: true })).toBeDisabled()
	await dialog().getByLabel('Metadata', { exact: true }).fill('WCF management only')
	await submit('Edit WCF Relay')
	await closeResult()
	await menu('WCF Relay new-wcf', 'Refresh status')
	await expect(page.getByText('WCF management only', { exact: true })).toBeVisible()
	await expect(
		page.getByText(
			'WCF resource management is supported. Legacy WCF binding tests are excluded.',
		),
	).toBeVisible()
})
test('creates a policy, reveals one slot, rotates it and hides secrets when closing', async () => {
	await connect()
	await page.getByRole('button', { name: 'Hybrid Connection bridge', exact: true }).click()
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
		'OFFLINE-RELAY-PRIMARY-1',
	)
	await dialog().getByRole('button', { name: 'Copy connection string', exact: true }).click()
	expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
		'EntityPath=bridge',
	)
	await app.evaluate(({ clipboard }) => clipboard.clear())
	await dialog().getByRole('button', { name: 'Close keys', exact: true }).click()
	await row.getByRole('button', { name: 'Regenerate', exact: true }).click()
	await submit('Regenerate key for SAS policy')
	await closeResult()
	await row.getByRole('button', { name: 'Keys', exact: true }).click()
	await dialog().getByRole('button', { name: 'Reveal key', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveValue(
		'OFFLINE-RELAY-PRIMARY-2',
	)
	await dialog().getByLabel('Key slot', { exact: true }).selectOption('SecondaryKey')
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveCount(0)
	await dialog().getByRole('button', { name: 'Reveal key', exact: true }).click()
	await expect(dialog().getByLabel('Selected key', { exact: true })).toHaveValue(
		'OFFLINE-RELAY-SECONDARY-1',
	)
	await dialog().getByRole('button', { name: 'Close keys', exact: true }).click()
	expect(await page.locator('body').innerText()).not.toContain('OFFLINE-RELAY-PRIMARY')
	await row.getByRole('button', { name: 'Delete', exact: true }).click()
	await submit('Delete SAS policy')
	await closeResult()
	await expect(row).toHaveCount(0)
})
test('blocks further changes after a lost write response until receipt/state review', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }).click()
	await dialog().getByLabel('Resource name', { exact: true }).fill('unknown-create')
	await submit('Create Hybrid Connection')
	await expect(dialog().getByRole('status')).toContainText('may have accepted')
	await closeResult()
	await expect(
		page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Check retained receipt', exact: true }).click()
	await expect(page.getByText('Last Relay change · unknown', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Refresh namespace', exact: true }).click()
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Hybrid Connection unknown-create', exact: true }),
	).toBeVisible()
	await page
		.getByRole('checkbox', {
			name: 'I checked Azure state and reviewed the uncertain outcome before another change.',
		})
		.check()
	await expect(
		page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }),
	).toBeEnabled()
})
test('cancels management login and explains denied access without leaking exceptions', async () => {
	await connect('slow')
	await expect(page.getByText('OFFLINE-RELAY', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Cancel Relay operation', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Connect Relay', exact: true })).toBeEnabled()
	await connect('denied')
	await expect(page.locator('.relay-explorer [role=alert]')).toContainText(
		'Relay management access denied',
	)
	expect(await page.locator('body').innerText()).not.toContain('SECRET')
})
