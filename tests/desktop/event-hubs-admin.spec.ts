import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture is excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-event-admin-'))
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
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline events')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function connect(management = true, tenant = 'fixture') {
	if (management) {
		await page
			.getByRole('checkbox', {
				name: 'Browse hubs and consumer groups with Entra management access',
			})
			.check()
		await page
			.getByLabel('Event Hubs namespace resource ID')
			.fill(
				'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture',
			)
		await page.getByLabel('Event Hubs management tenant').fill(tenant)
		await page
			.getByLabel('Event Hubs management client')
			.fill('22222222-2222-4222-8222-222222222222')
	} else await page.getByLabel('Known Event Hub name', { exact: true }).fill('telemetry')
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await expect(page.getByText('Event Hubs connected', { exact: true })).toBeVisible()
}
function dialog() {
	return page.getByRole('dialog')
}
async function resourceSubmit(name: string) {
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this (create|update|delete) action/ })
		.check()
	await dialog().getByRole('button', { name, exact: true }).click()
}
async function closeResult() {
	await dialog().getByRole('button', { name: 'Close administration result', exact: true }).click()
}
async function menu(hub: string, action: string) {
	await page.getByRole('button', { name: new RegExp(`^[▸▾] ${hub}$`) }).click({ button: 'right' })
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function groupMenu(group: string, action: string) {
	await page
		.locator('.eh-branch summary')
		.filter({ hasText: new RegExp(`^${group}$`) })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: action, exact: true }).click()
}
async function shot(name: string) {
	await mkdir('artifacts/validation-0.27.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.27.0/${name}.png` })
}
test('creates, edits and deletes hubs and groups through the tree with target confirmations', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Hub…', exact: true }).click()
	await dialog().getByLabel('Admin hub name').fill('admin-desktop')
	await dialog().getByLabel('Hub partition count').fill('3')
	await dialog().getByLabel('Hub retention hours').fill('48')
	await shot('event-hub-create')
	await resourceSubmit('Create Event Hub')
	await closeResult()
	await expect(page.getByRole('button', { name: '▸ admin-desktop', exact: true })).toBeVisible()
	await menu('admin-desktop', 'Edit Event Hub…')
	await expect(dialog().getByLabel('Hub retention hours')).toHaveValue('48')
	await expect(dialog().getByLabel('Hub partition count')).toBeDisabled()
	await dialog().getByLabel('Hub retention hours').fill('72')
	await dialog().getByLabel('Hub user metadata').fill('Desktop administration')
	await resourceSubmit('Save Event Hub')
	await closeResult()
	await page.getByRole('button', { name: '▸ admin-desktop', exact: true }).click()
	await menu('admin-desktop', 'Create consumer group…')
	await dialog().getByLabel('Admin consumer group name').fill('desktop-consumer')
	await dialog().getByLabel('Consumer group user metadata').fill('Original metadata')
	await resourceSubmit('Create consumer group')
	await closeResult()
	await groupMenu('desktop-consumer', 'Edit consumer group…')
	await expect(dialog().getByLabel('Consumer group user metadata')).toHaveValue(
		'Original metadata',
	)
	await dialog().getByLabel('Consumer group user metadata').fill('Updated metadata')
	await resourceSubmit('Save consumer group')
	await closeResult()
	await groupMenu('desktop-consumer', 'Delete consumer group…')
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this delete/ })
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Delete consumer group', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByLabel('Event resource deletion confirmation')
		.fill('DELETE admin-desktop/consumerGroups/desktop-consumer')
	await dialog().getByRole('button', { name: 'Delete consumer group', exact: true }).click()
	await closeResult()
	await expect(
		page.locator('.eh-branch summary').filter({ hasText: /^desktop-consumer$/ }),
	).toHaveCount(0)
	await menu('admin-desktop', 'Delete Event Hub…')
	await expect(dialog()).toContainText('retained events, consumer groups and hub SAS policies')
	await dialog().getByLabel('Event resource deletion confirmation').fill('DELETE admin-desktop')
	await shot('event-hub-delete')
	await resourceSubmit('Delete Event Hub')
	await closeResult()
	await expect(page.getByRole('button', { name: /^[▸▾] admin-desktop$/ })).toHaveCount(0)
})
test('supports keyboard tree menus and protects the built-in consumer group', async () => {
	await connect()
	const hub = page.getByRole('button', { name: '▸ telemetry', exact: true })
	await hub.focus()
	await page.keyboard.press('Shift+F10')
	await expect(page.getByRole('menuitem', { name: 'Edit Event Hub…', exact: true })).toBeVisible()
	await shot('event-hubs-context-menu')
	await page.keyboard.press('Escape')
	await expect(hub).toBeFocused()
	await hub.click()
	await page
		.locator('.eh-branch summary')
		.filter({ hasText: /^\$Default$/ })
		.click({ button: 'right' })
	await expect(
		page.getByRole('menuitem', { name: 'Delete consumer group…', exact: true }),
	).toHaveAttribute('data-disabled', '')
	await page.getByRole('menuitem', { name: 'Edit consumer group…', exact: true }).click()
	await expect(dialog().getByLabel('Admin consumer group name')).toHaveValue('$Default')
})
test('keeps administration unavailable for data-only SAS connections', async () => {
	await connect(false)
	await expect(
		page.getByRole('button', { name: 'Create Event Hub…', exact: true }),
	).toBeDisabled()
	await expect(
		page.getByRole('button', { name: 'Namespace SAS policies…', exact: true }),
	).toBeDisabled()
})
async function policySubmit(name: string) {
	await dialog()
		.getByRole('checkbox', { name: 'I reviewed this policy action and its effect on clients.' })
		.check()
	await dialog().getByRole('button', { name, exact: true }).click()
	await expect(dialog().getByLabel('Event SAS policy name')).toHaveCount(0)
}
async function allPolicies() {
	const more = dialog().getByRole('button', { name: 'More SAS policies', exact: true })
	if (await more.isVisible()) await more.click()
}
test('manages namespace policies, reveals and copies one key slot, and rotates only the confirmed slot', async () => {
	await connect()
	await page.getByRole('button', { name: 'Namespace SAS policies…', exact: true }).click()
	await dialog().getByRole('button', { name: 'Create SAS policy', exact: true }).click()
	await dialog().getByLabel('Event SAS policy name').fill('desktop-policy')
	await dialog().getByRole('checkbox', { name: 'Manage', exact: true }).check()
	await expect(dialog().getByRole('checkbox', { name: 'Send', exact: true })).toBeChecked()
	await expect(dialog().getByRole('checkbox', { name: 'Listen', exact: true })).toBeChecked()
	await policySubmit('Create Event Hubs SAS policy')
	await allPolicies()
	await dialog()
		.getByRole('button', { name: 'Edit SAS policy desktop-policy', exact: true })
		.click()
	await dialog().getByRole('checkbox', { name: 'Listen', exact: true }).uncheck()
	await expect(dialog().getByRole('checkbox', { name: 'Manage', exact: true })).not.toBeChecked()
	await policySubmit('Save Event Hubs SAS policy')
	await allPolicies()
	await dialog()
		.getByRole('button', { name: 'Keys for SAS policy desktop-policy', exact: true })
		.click()
	await dialog()
		.getByRole('button', { name: 'Reveal selected Event Hubs key', exact: true })
		.click()
	const primary = await dialog()
		.getByLabel('Revealed Event Hubs key', { exact: true })
		.inputValue()
	await dialog().getByLabel('Event SAS key slot').selectOption('SecondaryKey')
	await expect(dialog().getByLabel('Revealed Event Hubs key', { exact: true })).toHaveCount(0)
	await dialog()
		.getByRole('button', { name: 'Reveal selected Event Hubs key', exact: true })
		.click()
	const secondary = await dialog()
		.getByLabel('Revealed Event Hubs key', { exact: true })
		.inputValue()
	expect(secondary).not.toBe(primary)
	await dialog().getByRole('button', { name: 'Copy Event Hubs key', exact: true }).click()
	await expect(dialog()).toContainText('Copied.')
	expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(secondary)
	await app.evaluate(({ clipboard }) => clipboard.clear())
	await expect(dialog().getByLabel('Revealed Event Hubs key', { exact: true })).toHaveCount(0)
	await dialog()
		.getByRole('button', { name: 'Rotate SAS policy desktop-policy', exact: true })
		.click()
	await dialog()
		.getByLabel('Event SAS action confirmation')
		.fill('REGENERATE namespace/authorizationRules/desktop-policy SecondaryKey')
	await dialog().getByLabel('Event SAS key slot').selectOption('PrimaryKey')
	await expect(dialog().getByLabel('Event SAS action confirmation')).toHaveValue('')
	await dialog()
		.getByLabel('Event SAS action confirmation')
		.fill('REGENERATE namespace/authorizationRules/desktop-policy PrimaryKey')
	await shot('event-hubs-key-rotation')
	await policySubmit('Regenerate Event Hubs key')
	await allPolicies()
	await dialog()
		.getByRole('button', { name: 'Keys for SAS policy desktop-policy', exact: true })
		.click()
	await dialog()
		.getByRole('button', { name: 'Reveal selected Event Hubs key', exact: true })
		.click()
	expect(
		await dialog().getByLabel('Revealed Event Hubs key', { exact: true }).inputValue(),
	).not.toBe(primary)
	await dialog().getByLabel('Event SAS key slot').selectOption('SecondaryKey')
	await dialog()
		.getByRole('button', { name: 'Reveal selected Event Hubs key', exact: true })
		.click()
	await expect(dialog().getByLabel('Revealed Event Hubs key', { exact: true })).toHaveValue(
		secondary,
	)
	await dialog()
		.getByRole('button', { name: 'Delete SAS policy desktop-policy', exact: true })
		.click()
	await expect(dialog().getByLabel('Revealed Event Hubs key', { exact: true })).toHaveCount(0)
	await dialog()
		.getByLabel('Event SAS action confirmation')
		.fill('DELETE namespace/authorizationRules/desktop-policy')
	await policySubmit('Delete Event Hubs SAS policy')
	await allPolicies()
	await expect(
		dialog().getByRole('button', { name: 'Keys for SAS policy desktop-policy', exact: true }),
	).toHaveCount(0)
})
test('scopes hub policies to the clicked hub and clears secrets on close', async () => {
	await connect()
	await menu('telemetry', 'SAS policies and keys…')
	await expect(dialog()).toContainText('fixture.servicebus.windows.net / telemetry')
	await expect(dialog()).not.toContainText('RootManageSharedAccessKey')
	await dialog()
		.getByRole('button', { name: 'Keys for SAS policy hub-reader', exact: true })
		.click()
	await dialog()
		.getByRole('button', { name: 'Reveal selected Event Hubs key', exact: true })
		.click()
	await expect(
		dialog().getByLabel('Revealed Event Hubs connection string', { exact: true }),
	).toHaveValue(/EntityPath=telemetry/)
	await page.keyboard.press('Escape')
	await menu('telemetry', 'SAS policies and keys…')
	await expect(dialog().getByLabel('Revealed Event Hubs key', { exact: true })).toHaveCount(0)
})
test('retains unknown results and requires review before another administration change', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Hub…', exact: true }).click()
	await dialog().getByLabel('Admin hub name').fill('admin-unknown')
	await resourceSubmit('Create Event Hub')
	await expect(
		dialog().getByRole('region', { name: 'Event administration result' }),
	).toContainText('unknown')
	await dialog()
		.getByRole('button', { name: 'Check administration receipt', exact: true })
		.click()
	await expect(
		dialog().getByRole('button', { name: 'Create Event Hub', exact: true }),
	).toBeDisabled()
	await shot('event-hubs-admin-unknown')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Namespace SAS policies…', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Event administration result' }),
	).toContainText('admin-unknown')
	await expect(
		dialog().getByRole('button', { name: 'Create SAS policy', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed Azure state and the risk of repeating this change.',
		})
		.check()
	await dialog()
		.getByRole('button', { name: 'Allow another administration change', exact: true })
		.click()
	await expect(
		dialog().getByRole('button', { name: 'Create SAS policy', exact: true }),
	).toBeEnabled()
})
test('cancels an in-flight administration change with an uncertain receipt', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Hub…', exact: true }).click()
	await dialog().getByLabel('Admin hub name').fill('admin-slow')
	await resourceSubmit('Create Event Hub')
	await expect(
		dialog().getByRole('region', { name: 'Event administration progress' }),
	).toBeVisible()
	// Allow the offline preflight to reach its deliberately stalled PUT.
	await expect.poll(() => app.evaluate(() => process.pid)).toBeGreaterThan(0)
	await page.waitForTimeout(300)
	await page.keyboard.press('Escape')
	await expect(dialog()).toBeVisible()
	await dialog()
		.getByRole('button', { name: 'Cancel administration operation', exact: true })
		.click()
	await expect(
		dialog().getByRole('region', { name: 'Event administration result' }),
	).toContainText('unknown')
})
test('configures Capture explicitly and preserves it during later hub edits', async () => {
	await connect()
	await menu('telemetry', 'Edit Event Hub…')
	await dialog()
		.locator('summary')
		.filter({ hasText: /^Capture$/ })
		.click()
	await dialog().getByLabel('Hub Capture action').selectOption('configure')
	await dialog()
		.getByLabel('Capture storage resource ID')
		.fill(
			'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Storage/storageAccounts/fixturestore',
		)
	await dialog().getByLabel('Capture blob container').fill('desktop-archive')
	await dialog().getByLabel('Capture interval seconds').fill('59')
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this update action/ })
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Save Event Hub', exact: true }),
	).toBeDisabled()
	await dialog().getByLabel('Capture interval seconds').fill('120')
	await expect(
		dialog().getByRole('checkbox', { name: /I reviewed this update action/ }),
	).not.toBeChecked()
	await resourceSubmit('Save Event Hub')
	await closeResult()
	await menu('telemetry', 'Edit Event Hub…')
	await dialog().getByLabel('Hub user metadata').fill('Capture preserved')
	await resourceSubmit('Save Event Hub')
	await closeResult()
	await menu('telemetry', 'Edit Event Hub…')
	await dialog().locator('summary').filter({ hasText: 'Current Azure properties' }).click()
	await expect(dialog()).toContainText('desktop-archive')
	await shot('event-hub-capture')
})
test('shows renewed management sign-in in the administration dialog and preserves a confirmed result', async () => {
	await connect()
	await page.getByRole('button', { name: 'Create Event Hub…', exact: true }).click()
	await dialog().getByLabel('Admin hub name').fill('admin-late-admin-reauth')
	await resourceSubmit('Create Event Hub')
	await expect(dialog().getByText('OFFLINE-ADMIN', { exact: true })).toBeVisible()
	await expect(
		dialog().getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeVisible()
	await expect(
		dialog().getByRole('region', { name: 'Event administration result' }),
	).toContainText('confirmed')
})
