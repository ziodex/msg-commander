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
	await page.locator('.entity-admin > summary').click()
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
const dialog = () => page.getByRole('dialog', { name: 'Bulk entity actions', exact: true })
const checked = (kind: string, path: string) =>
	page.getByRole('checkbox', { name: `Select ${kind} ${path} for bulk actions`, exact: true })
async function add(name: string) {
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	const editor = page.getByRole('dialog', { name: 'Create queue', exact: true })
	await editor.getByLabel('Entity name', { exact: true }).fill(name)
	await editor.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(editor).toHaveCount(0)
}
async function open(action = 'Disabled') {
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk entities…', exact: true }).click()
	await dialog().getByLabel('Bulk entity action', { exact: true }).selectOption(action)
	await dialog().getByRole('button', { name: 'Review entity actions', exact: true }).click()
	await expect(
		dialog().getByRole('checkbox', { name: /I reviewed every affected entity/ }),
	).toBeVisible()
}
async function confirm(action: string, count: number) {
	if (await dialog().getByLabel('Bulk entity confirmation', { exact: true }).count())
		await dialog()
			.getByLabel('Bulk entity confirmation', { exact: true })
			.fill(`${action} fixture.servicebus.windows.net ${count} ENTITIES`)
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed every affected entity and understand the impact of this action.',
			exact: true,
		})
		.check()
	await dialog().getByRole('button', { name: 'Apply entity actions', exact: true }).click()
}
async function screenshot(name: string) {
	await mkdir('artifacts/validation-0.19.0', { recursive: true })
	await page.screenshot({ path: `artifacts/validation-0.19.0/${name}.png` })
}
test('bulk status selection survives paging, filtering and collapse, and refreshes all tree rows', async () => {
	await page.getByRole('button', { name: 'Select entities', exact: true }).click()
	await checked('queue', 'orders').check()
	await page.getByRole('button', { name: 'Load more queues', exact: true }).click()
	await checked('queue', 'archive').check()
	await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
	await checked('subscription', 'order-events/Subscriptions/billing').check()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('nothing-visible')
	await page.getByRole('button', { name: 'Collapse all entities', exact: true }).click()
	await open()
	await expect(dialog().locator('tbody tr')).toHaveCount(3)
	await expect(
		dialog().getByRole('button', { name: 'Apply entity actions', exact: true }),
	).toBeDisabled()
	await screenshot('bulk-entity-status-review')
	await confirm('SET Disabled', 3)
	await expect(dialog().getByRole('region', { name: 'Bulk entity result' })).toContainText(
		'3 changes confirmed',
	)
	await page.keyboard.press('Escape')
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('')
	await page.getByRole('button', { name: 'Expand all entities', exact: true }).click()
	await expect(page.getByRole('button', { name: 'orders Disabled', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'archive Disabled', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'billing Disabled', exact: true })).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'order-events Active', exact: true }),
	).toBeVisible()
})
test('bulk deletion reviews topic cascade once, resets confirmation after changes and removes affected tree rows', async () => {
	await page.getByRole('button', { name: 'Expand topic order-events', exact: true }).click()
	await page
		.getByRole('button', { name: 'billing Active', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Add to bulk selection', exact: true }).click()
	await checked('topic', 'order-events').check()
	await open('delete')
	await expect(dialog().locator('tbody tr')).toHaveCount(1)
	await expect(dialog()).toContainText('order-events/Subscriptions/audit')
	await expect(dialog()).toContainText('order-events/Subscriptions/billing')
	await expect(dialog()).toContainText('3 entities with 1 broker action')
	await dialog()
		.getByLabel('Bulk entity confirmation', { exact: true })
		.fill('DELETE fixture.servicebus.windows.net 3 ENTITIES')
	await dialog()
		.getByRole('checkbox', { name: /I reviewed every affected entity/ })
		.check()
	await dialog().getByRole('button', { name: 'Change selection or action', exact: true }).click()
	await dialog().getByRole('button', { name: 'Review entity actions', exact: true }).click()
	await expect(dialog().getByLabel('Bulk entity confirmation', { exact: true })).toHaveValue('')
	await expect(
		dialog().getByRole('checkbox', { name: /I reviewed every affected entity/ }),
	).not.toBeChecked()
	await screenshot('bulk-entity-delete-review')
	await confirm('DELETE', 3)
	await expect(dialog().getByRole('region', { name: 'Bulk entity result' })).toContainText(
		'1 change confirmed',
	)
	await screenshot('bulk-entity-delete-result')
	await page.keyboard.press('Escape')
	await expect(
		page.getByRole('button', { name: 'order-events Active', exact: true }),
	).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'billing Active', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
})
test('bulk folder selection includes descendants with exact boundaries and group context actions select subscriptions', async () => {
	await add('team/one')
	await add('team/nested/two')
	await add('teamwork/three')
	await page.getByRole('button', { name: 'Select entities', exact: true }).click()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('one')
	await page.getByRole('button', { name: 'Select entire queue folder team', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Bulk actions (2)…', exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: 'order-events Active', exact: true })
		.click({ button: 'right' })
	await page
		.getByRole('menuitem', { name: 'Select all subscriptions for bulk actions…', exact: true })
		.click()
	await expect(page.getByRole('button', { name: 'Bulk actions (4)…', exact: true })).toBeVisible()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('')
	await screenshot('bulk-entity-tree-selection')
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk entities…', exact: true }).click()
	await expect(
		dialog().getByLabel('Bulk entity action').locator('option[value=SendDisabled]'),
	).toHaveJSProperty('disabled', true)
	await dialog().getByRole('button', { name: 'Review entity actions', exact: true }).click()
	await expect(dialog()).toContainText('team/nested/two')
	await expect(dialog()).not.toContainText('teamwork/three')
	await confirm('SET Disabled', 4)
	await expect(dialog().getByRole('region', { name: 'Bulk entity result' })).toContainText(
		'4 changes confirmed',
	)
})
test('bulk entity cancellation preserves earlier successes and keeps the dialog open until the final result', async () => {
	await add('bulk-wait-before')
	await page.getByRole('button', { name: 'Select entities', exact: true }).click()
	await checked('queue', 'empty').check()
	await checked('queue', 'bulk-wait-before').check()
	await checked('queue', 'orders').check()
	await open('delete')
	await confirm('DELETE', 3)
	await expect(dialog()).toContainText('applying: bulk-wait-before')
	await page.keyboard.press('Escape')
	await expect(dialog()).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel entity actions', exact: true }).click()
	const result = dialog().getByRole('region', { name: 'Bulk entity result' })
	await expect(result).toContainText('cancelled')
	await expect(result).toContainText('1 change confirmed')
	await expect(result.locator('tbody tr').filter({ hasText: 'orders' })).toContainText(
		'not-started',
	)
	await screenshot('bulk-entity-cancelled')
	await page.keyboard.press('Escape')
	await expect(page.getByRole('button', { name: 'empty Active', exact: true })).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
})
test('bulk entity unknown outcome survives reopening and requires review before another action', async () => {
	await add('bulk-unknown')
	await page.getByRole('button', { name: 'Select entities', exact: true }).click()
	await checked('queue', 'bulk-unknown').check()
	await checked('queue', 'orders').check()
	await open()
	await confirm('SET Disabled', 2)
	const result = dialog().getByRole('region', { name: 'Bulk entity result' })
	await expect(result).toContainText('1 uncertain')
	await expect(result).not.toContainText('SECRET')
	await expect(
		dialog().getByRole('button', { name: 'Prepare another entity action', exact: true }),
	).toBeDisabled()
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk entities…', exact: true }).click()
	await expect(result).toContainText('1 uncertain')
	await screenshot('bulk-entity-uncertain')
	await dialog()
		.getByRole('checkbox', { name: /I inspected the affected entities/ })
		.check()
	await dialog()
		.getByRole('button', { name: 'Prepare another entity action', exact: true })
		.click()
	await expect(
		dialog().getByRole('button', { name: 'Review entity actions', exact: true }),
	).toBeVisible()
})
