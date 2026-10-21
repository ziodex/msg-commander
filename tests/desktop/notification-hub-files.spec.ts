import { hideOperations } from './support/operations-log'
import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
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
async function connect() {
	await page
		.getByLabel('Notification Hubs namespace resource ID', { exact: true })
		.fill(resourceId)
	await page.getByLabel('Notification Hubs management tenant', { exact: true }).fill('fixture')
	await page.getByRole('button', { name: 'Connect Notification Hubs', exact: true }).click()
	await expect(page.getByText('Notification Hubs connected', { exact: true })).toBeVisible()
}
const dialog = () =>
	page.getByRole('dialog', { name: 'Notification Hubs configuration', exact: true })
async function open() {
	await connect()
	await page.getByRole('button', { name: 'Configuration files…', exact: true }).click()
}
async function choose(path: string) {
	await app.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
	}, path)
	await dialog()
		.getByRole('button', { name: 'Choose Notification Hubs configuration…', exact: true })
		.click()
}
function archive(names = ['new-file-hub']) {
	return {
		format: 'msg-commander/notification-hubs',
		version: 1,
		exportedAt: new Date().toISOString(),
		sourceNamespace: 'source.servicebus.windows.net',
		resources: names.map((name) => ({
			name,
			replaceTags: true,
			settings: {
				registrationTtl: '30.00:00:00',
				tags: [{ name: 'purpose', value: 'import' }],
			},
			policies: [{ name: 'readers', rights: ['Listen'] }],
		})),
		namespacePolicies: [],
		warnings: [],
	}
}
async function apply() {
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed the destination, selected creates and updates, excluded fields and key behavior.',
			exact: true,
		})
		.check()
	await dialog()
		.getByRole('button', {
			name: 'Apply selected Notification Hubs configuration',
			exact: true,
		})
		.click()
}
test('reviews creates and updates, uses checkbox confirmation and retains results after reopening', async () => {
	const file = join(directory, 'hubs.json')
	await writeFile(file, JSON.stringify(archive(['new-file-hub', 'alerts'])))
	await open()
	await choose(file)
	await expect(
		dialog().getByRole('checkbox', { name: 'Import hub/new-file-hub', exact: true }),
	).toBeChecked()
	await expect(
		dialog().getByRole('checkbox', { name: 'Import hub/alerts', exact: true }),
	).not.toBeChecked()
	await expect(
		dialog().getByRole('button', {
			name: 'Apply selected Notification Hubs configuration',
			exact: true,
		}),
	).toBeDisabled()
	await dialog().getByRole('checkbox', { name: 'Import hub/alerts', exact: true }).check()
	await dialog()
		.locator('tbody details')
		.nth(2)
		.getByText('Review settings', { exact: true })
		.click()
	await expect(dialog().getByText('Current', { exact: true })).toBeVisible()
	await mkdir('artifacts/validation-0.39.0', { recursive: true })
	await page.screenshot({
		path: 'artifacts/validation-0.39.0/notification-hubs-import-preview.png',
	})
	await apply()
	await expect(dialog().getByRole('status')).toContainText('4/4 targets confirmed')
	await dialog()
		.getByRole('button', { name: 'Close Notification Hubs configuration', exact: true })
		.click()
	await page.getByRole('button', { name: 'View import results', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('4/4 targets confirmed')
	await dialog()
		.getByRole('button', { name: 'Check retained import receipt', exact: true })
		.click()
})
test('keeps partial receipts after cancellation and blocks writes until an uncertain import is reviewed', async () => {
	const file = join(directory, 'cancel.json')
	await writeFile(file, JSON.stringify(archive(['confirmed-import', 'write-slow-import'])))
	await open()
	await choose(file)
	await apply()
	await expect(
		dialog().getByText('Importing Notification Hubs configuration: 2/4 targets confirmed.', {
			exact: true,
		}),
	).toBeVisible()
	await dialog()
		.getByRole('button', { name: 'Cancel Notification Hubs operation', exact: true })
		.click()
	await expect(dialog().getByRole('status')).toContainText('2/4 targets confirmed')
	await expect(dialog().getByText('not-attempted', { exact: true })).toBeVisible()
	await dialog()
		.getByRole('button', { name: 'Close Notification Hubs configuration', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Create Notification Hub', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'View import results', exact: true }).click()
	await dialog()
		.getByRole('checkbox', {
			name: 'I checked Azure state and reviewed the uncertain import before another change.',
			exact: true,
		})
		.check()
	await dialog()
		.getByRole('button', { name: 'Close Notification Hubs configuration', exact: true })
		.click()
	await expect(
		page.getByRole('button', { name: 'Create Notification Hub', exact: true }),
	).toBeEnabled()
})

test('shows renewed Microsoft sign-in inside the configuration dialog with the log hidden', async () => {
	await connect()
	await hideOperations(page)
	const file = join(directory, 'renew.json')
	await writeFile(file, JSON.stringify(archive(['config-renew'])))
	await page.getByRole('button', { name: 'Configuration files…', exact: true }).click()
	await choose(file)
	await apply()
	await expect(
		dialog().getByRole('region', { name: 'Configuration Microsoft sign-in', exact: true }),
	).toBeVisible()
	await expect(dialog().getByText('OFFLINE-PROVIDER', { exact: true })).toBeVisible()
	await expect(
		dialog().getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeVisible()
	await dialog()
		.getByRole('button', { name: 'Cancel Notification Hubs operation', exact: true })
		.click()
	await expect(dialog().getByRole('status')).toContainText('A write may have been accepted')
})
