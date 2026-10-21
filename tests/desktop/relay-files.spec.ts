import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixture is excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Relay/namespaces/fixture'
test.beforeEach(async () => {
	await mkdir('artifacts/validation-0.33.0', { recursive: true })
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
const dialog = () => page.getByRole('dialog', { name: 'Relay configuration', exact: true })
async function choose(path: string) {
	await app.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
	}, path)
	await dialog().getByRole('button', { name: 'Choose Relay configuration…', exact: true }).click()
}
function archive(names = ['new-file-bridge']) {
	return {
		format: 'msg-commander/relay',
		version: 1,
		exportedAt: new Date().toISOString(),
		sourceNamespace: 'source.servicebus.windows.net',
		resources: names.map((name) => ({
			kind: 'hybrid',
			name,
			settings: {
				userMetadata: 'Imported from configuration',
				requiresClientAuthorization: true,
				relayType: null,
				requiresTransportSecurity: null,
			},
			policies: [{ name: 'readers', rights: ['Listen'] }],
		})),
		namespacePolicies: [],
		warnings: [],
	}
}
async function open() {
	await connect()
	await page.getByRole('button', { name: 'Relay configuration…', exact: true }).click()
}
async function apply() {
	await dialog()
		.getByRole('checkbox', {
			name: 'I reviewed the destination, selected creates and updates, excluded fields and key behavior.',
			exact: true,
		})
		.check()
	await dialog()
		.getByRole('button', { name: 'Apply selected Relay configuration', exact: true })
		.click()
}
test('reviews creates and updates, applies selected targets and retains results after reopening', async () => {
	const path = join(directory, 'relay.json')
	await writeFile(path, JSON.stringify(archive(['new-file-bridge', 'bridge'])))
	await open()
	await choose(path)
	await expect(
		dialog().getByRole('checkbox', { name: 'Import hybrid/new-file-bridge', exact: true }),
	).toBeChecked()
	await expect(
		dialog().getByRole('checkbox', { name: 'Import hybrid/bridge', exact: true }),
	).not.toBeChecked()
	await expect(
		dialog().getByRole('button', { name: 'Apply selected Relay configuration', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('checkbox', { name: 'Import hybrid/bridge', exact: true }).check()
	await dialog().locator('details').nth(2).getByText('Review settings', { exact: true }).click()
	await expect(dialog().getByText('Current', { exact: true })).toBeVisible()
	await mkdir('artifacts/validation-0.33.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.33.0/relay-import-preview.png' })
	await apply()
	await expect(dialog().getByRole('status')).toContainText('4/4 targets confirmed')
	await dialog().getByRole('button', { name: 'Close Relay configuration', exact: true }).click()
	await page.getByRole('button', { name: 'View import results', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('4/4 targets confirmed')
	await dialog()
		.getByRole('button', { name: 'Check retained import receipt', exact: true })
		.click()
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await expect
		.poll(() =>
			dialog()
				.getByRole('button', { name: 'Close Relay configuration', exact: true })
				.evaluate((el) => getComputedStyle(el).color),
		)
		.toBe(await page.evaluate(() => getComputedStyle(document.body).color))
	await page.screenshot({ path: 'artifacts/validation-0.33.0/relay-import-results-dark.png' })
	await dialog().getByRole('button', { name: 'Close Relay configuration', exact: true }).click()
	await page.getByRole('button', { name: 'Load more Hybrid Connections', exact: true }).click()
	await page
		.getByRole('button', { name: 'Hybrid Connection new-file-bridge', exact: true })
		.click()
	await expect(page.getByText('Imported from configuration', { exact: true })).toBeVisible()
})
test('keeps partial outcomes after cancellation and blocks changes until an uncertain import is reviewed', async () => {
	const path = join(directory, 'cancel.json')
	await writeFile(path, JSON.stringify(archive(['confirmed-import', 'write-slow-import'])))
	await open()
	await choose(path)
	await apply()
	await expect(
		dialog().getByRole('button', { name: 'Cancel Relay operation', exact: true }),
	).toBeVisible()
	// Wait for the second target to reach its slow write in the fixture.
	await expect(
		dialog().getByText('Importing Relay configuration: 2/4 targets confirmed.', {
			exact: true,
		}),
	).toBeVisible()
	await dialog().getByRole('button', { name: 'Cancel Relay operation', exact: true }).click()
	await expect(dialog().getByRole('status')).toContainText('2/4 targets confirmed')
	await expect(dialog().getByText('not-attempted', { exact: true })).toBeVisible()
	await dialog().getByRole('button', { name: 'Close Relay configuration', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }),
	).toBeDisabled()
	await page
		.getByRole('checkbox', {
			name: 'I checked Azure state and reviewed the uncertain import before another change.',
			exact: true,
		})
		.check()
	await expect(
		page.getByRole('button', { name: 'Create Hybrid Connection', exact: true }),
	).toBeEnabled()
})
