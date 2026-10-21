import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'The offline fixture is excluded from installers.',
)
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-messaging-config-'))
	await mkdir('artifacts/validation-0.51.0', { recursive: true })
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
})
test.afterEach(async () => {
	await app?.close()
	await rm(directory, { recursive: true, force: true })
})
async function connect(service: 'Service Bus' | 'Event Hubs' = 'Service Bus') {
	await page.getByRole('button', { name: service, exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline configuration')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	if (service === 'Service Bus')
		await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	else {
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
		await page.getByLabel('Event Hubs management tenant').fill('fixture')
		await page
			.getByLabel('Event Hubs management client')
			.fill('22222222-2222-4222-8222-222222222222')
		await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	}
	if (service === 'Service Bus') {
		await page.getByRole('button', { name: 'Actions', exact: true }).click()
		await page
			.getByRole('menuitem', { name: 'Service Bus configuration…', exact: true })
			.click()
	} else
		await page.getByRole('button', { name: 'Event Hubs configuration…', exact: true }).click()
}
const modal = () =>
	page
		.getByRole('dialog')
		.filter({ has: page.getByRole('tablist', { name: 'Configuration views' }) })
async function dialogs(openPath = '', savePath = '') {
	await app.evaluate(
		({ dialog }, v) => {
			dialog.showOpenDialog = async () => ({
				canceled: !v.openPath,
				filePaths: v.openPath ? [v.openPath] : [],
			})
			dialog.showSaveDialog = async () => ({ canceled: !v.savePath, filePath: v.savePath })
		},
		{ openPath, savePath },
	)
}
async function choose(path: string) {
	await dialogs(path)
	await modal().getByRole('button', { name: 'Choose configuration…', exact: true }).click()
}
async function apply() {
	await modal()
		.getByRole('checkbox', {
			name: 'I reviewed the destination, selected changes, dependencies and new policy keys.',
		})
		.check()
	await modal().getByRole('button', { name: 'Apply selected configuration', exact: true }).click()
}
function json(names: string[], metadata = '') {
	return JSON.stringify({
		format: 'msg-commander/messaging-configuration',
		version: 1,
		service: 'service-bus',
		exportedAt: new Date().toISOString(),
		sourceNamespace: 'source',
		resources: names.map((name) => ({
			target: { kind: 'queue', name, parentKind: null, parentName: null },
			settings: { userMetadata: metadata },
			rulesSpecified: false,
			issue: null,
		})),
		warnings: [],
	})
}
test('retains uncertain results across closing and requires explicit Azure review before another import', async () => {
	await connect()
	const path = join(directory, 'uncertain.json')
	await writeFile(path, json(['unknown-entity-import', 'z-never']))
	await choose(path)
	await apply()
	await expect(
		modal().getByRole('table', { name: 'Configuration import results' }),
	).toContainText('unknown')
	await expect(modal()).toContainText('not-attempted')
	await modal().getByRole('button', { name: 'Close configuration', exact: true }).click()
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Service Bus configuration…', exact: true }).click()
	await expect(modal()).toContainText('The outcome may be uncertain')
	await modal().getByRole('tab', { name: 'Import', exact: true }).click()
	await expect(
		modal().getByRole('button', { name: 'Choose configuration…', exact: true }),
	).toBeDisabled()
	await modal().getByRole('tab', { name: 'Results', exact: true }).click()
	await modal()
		.getByRole('button', {
			name: 'I checked the result in Azure; start a fresh review',
			exact: true,
		})
		.click()
	await expect(
		modal().getByRole('button', { name: 'Choose configuration…', exact: true }),
	).toBeEnabled()
})
test('cancels import before dispatch and shows a retained cancelled result', async () => {
	await connect()
	const path = join(directory, 'slow.json')
	await writeFile(path, json(['a-preflight', 'z-next'], 'slow-preflight'))
	await choose(path)
	await apply()
	await modal()
		.getByRole('button', { name: 'Cancel configuration operation', exact: true })
		.click()
	await expect(
		modal().getByRole('table', { name: 'Configuration import results' }),
	).toContainText('cancelled')
	await expect(modal()).toContainText('not-attempted')
})
