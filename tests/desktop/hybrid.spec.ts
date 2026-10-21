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
	directory = await mkdtemp(join(tmpdir(), 'commander-hybrid-'))
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
const testing = () => page.getByRole('dialog', { name: 'Test Hybrid Connection', exact: true })
async function open(name = 'bridge') {
	await page.getByRole('button', { name: 'Test Hybrid Connection…', exact: true }).click()
	await testing().getByLabel('Hybrid Connection name', { exact: true }).fill(name)
}
async function send() {
	await testing()
		.getByRole('checkbox', { name: /I reviewed the endpoint/ })
		.check()
	await testing().getByRole('button', { name: 'Send test', exact: true }).click()
}
test('tests a known connection without ARM and inspects colored JSON in a modal', async () => {
	await open()
	await testing().getByLabel('Maximum exchanges', { exact: true }).fill('2')
	await send()
	await expect(testing().getByText(/completed · 2 exchange/)).toBeVisible()
	await testing().getByRole('button', { name: 'Inspect exchange 1', exact: true }).click()
	const inspector = page.getByRole('dialog', { name: 'Inspect Relay exchange 1', exact: true })
	await expect(inspector.locator('.json-key').filter({ hasText: '"reply"' })).toBeVisible()
	await expect(inspector.locator('.json-number')).toHaveText('9007199254740993')
	await mkdir('artifacts/validation-0.32.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.32.0/hybrid-inspection.png' })
	await inspector.getByRole('button', { name: 'Close exchange', exact: true }).click()
	await testing().getByRole('button', { name: 'Close testing', exact: true }).click()
	await page.getByRole('button', { name: 'Test Hybrid Connection…', exact: true }).click()
	await expect(testing().getByText(/completed · 2 exchange/)).toBeVisible()
})
test('runs an HTTP listener and sender together and cancels another idle listener', async () => {
	await open()
	await testing().getByLabel('Test mode', { exact: true }).selectOption('http-listen')
	await testing().getByLabel('Response body', { exact: true }).fill('{"response":"listening"}')
	await testing().getByLabel('Maximum exchanges', { exact: true }).fill('1')
	await testing()
		.getByRole('checkbox', { name: /I reviewed the endpoint/ })
		.check()
	await testing().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(testing().getByText('0 / 1 exchanges · online', { exact: true })).toBeVisible()
	await testing().getByRole('tab', { name: 'Configure test', exact: true }).click()
	await testing().getByLabel('Test mode', { exact: true }).selectOption('http-send')
	await send()
	await expect(testing().getByText(/completed · 1 exchange/)).toHaveCount(2)
	await testing().getByRole('tab', { name: 'Configure test', exact: true }).click()
	await testing().getByLabel('Test mode', { exact: true }).selectOption('http-listen')
	await testing()
		.getByRole('checkbox', { name: /I reviewed the endpoint/ })
		.check()
	await testing().getByRole('button', { name: 'Start listener', exact: true }).click()
	await expect(testing().getByText('0 / 10 exchanges · online', { exact: true })).toBeVisible()
	await testing().getByRole('button', { name: 'Close testing', exact: true }).click()
	await page.getByRole('button', { name: 'Test Hybrid Connection…', exact: true }).click()
	await testing().getByRole('button', { name: 'Stop test', exact: true }).click()
	await expect(testing().getByText(/cancelled · 0 exchange/)).toBeVisible()
	await page.screenshot({ path: 'artifacts/validation-0.32.0/hybrid-jobs.png' })
	await page.evaluate(() => document.documentElement.classList.add('dark'))
	await expect
		.poll(() =>
			testing()
				.getByRole('button', { name: 'Close testing', exact: true })
				.evaluate((el) => getComputedStyle(el).color),
		)
		.toBe('rgb(238, 233, 224)')
	await page.screenshot({ path: 'artifacts/validation-0.32.0/hybrid-dark.png' })
})
test('requires checkbox review for uncertain sends and supports binary stream inspection', async () => {
	await open('unknown')
	await send()
	await expect(testing().getByText(/unknown · 1 exchange/)).toBeVisible()
	await testing().getByRole('tab', { name: 'Configure test', exact: true }).click()
	await testing()
		.getByRole('checkbox', { name: /I reviewed the endpoint/ })
		.check()
	await expect(testing().getByRole('button', { name: 'Send test', exact: true })).toBeDisabled()
	await testing()
		.getByRole('tab', { name: /Test jobs/ })
		.click()
	await testing()
		.getByRole('checkbox', { name: /I reviewed the uncertain exchange/ })
		.check()
	await testing().getByRole('tab', { name: 'Configure test', exact: true }).click()
	await testing().getByLabel('Hybrid Connection name', { exact: true }).fill('bridge')
	await testing().getByLabel('Test mode', { exact: true }).selectOption('stream-send')
	await testing().getByLabel('Body encoding', { exact: true }).selectOption('base64')
	await testing().getByLabel('Request body', { exact: true }).fill('AP8BCg==')
	await send()
	await expect(testing().getByText(/completed · 1 exchange/)).toBeVisible()
	await testing().getByRole('button', { name: 'Inspect exchange 1', exact: true }).first().click()
	const inspector = page.getByRole('dialog', { name: 'Inspect Relay exchange 1', exact: true })
	await inspector.getByRole('button', { name: 'Request', exact: true }).click()
	await expect(inspector.locator('pre')).toContainText('00 ff 01 0a')
	await inspector.getByRole('button', { name: 'Close exchange', exact: true }).click()
	await testing()
		.getByRole('checkbox', { name: /Stop all Hybrid Connection jobs/ })
		.check()
	await testing().getByRole('button', { name: 'Clear testing history', exact: true }).click()
	await expect(
		testing().getByText('No test jobs for this profile yet.', { exact: true }),
	).toBeVisible()
})
test('opens testing for the Hybrid Connection selected through the tree context menu', async () => {
	await page.getByLabel('Relay namespace resource ID', { exact: true }).fill(resourceId)
	await page.getByRole('button', { name: 'Connect Relay', exact: true }).click()
	const node = page.getByRole('button', { name: 'Hybrid Connection bridge', exact: true })
	await node.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Test Hybrid Connection…', exact: true }).click()
	await expect(testing().getByLabel('Hybrid Connection name', { exact: true })).toHaveValue(
		'bridge',
	)
})
