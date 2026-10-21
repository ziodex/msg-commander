import { hideOperations } from './support/operations-log'
import { generateKeyPairSync } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
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
const dialog = () => page.getByRole('dialog')
async function open() {
	await page
		.getByRole('button', { name: 'Notification Hub alerts', exact: true })
		.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Provider credentials…', exact: true }).click()
	await expect(
		dialog().getByRole('button', { name: 'Refresh provider status', exact: true }),
	).toBeEnabled()
}
async function choose(path: string) {
	await app.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
	}, path)
	await dialog().getByRole('button', { name: 'Import credential file…', exact: true }).click()
}
async function send() {
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByRole('button', { name: 'Save provider credentials', exact: true }).click()
	await expect(dialog().getByText('Provider update acknowledged', { exact: true })).toBeVisible()
}
test('configures WNS through a context menu with checkbox review and redacted reopened status', async () => {
	await connect()
	await open()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('wns')
	await dialog().getByLabel('WNS Package SID', { exact: true }).fill('PRIVATE-SID')
	await dialog().getByLabel('WNS client secret', { exact: true }).fill('PRIVATE-SECRET')
	await expect(
		dialog().getByRole('button', { name: 'Save provider credentials', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByLabel('WNS client secret', { exact: true }).fill('PRIVATE-SECRET-2')
	await expect(dialog().getByRole('checkbox', { name: /I reviewed this hub/ })).not.toBeChecked()
	await send()
	await expect(dialog()).not.toContainText('PRIVATE-SECRET')
	await dialog().getByRole('button', { name: 'Close provider result' }).click()
	await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('wns')
	await expect(dialog()).toContainText('Azure reports a credential object')
	await expect(dialog().getByLabel('WNS client secret', { exact: true })).toHaveValue('')
	await expect(dialog().getByLabel('WNS Package SID', { exact: true })).toHaveValue('')
})
test('imports and applies APNS token keys with local validation and fixed actions on a small window', async () => {
	await connect()
	await open()
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await dialog().getByLabel('APNS Key ID', { exact: true }).fill('ABCDEFGHIJ')
	await dialog().getByLabel('APNS Team ID', { exact: true }).fill('0123456789')
	await dialog().getByLabel('APNS Bundle ID', { exact: true }).fill('com.example.app')
	const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
			.privateKey.export({ format: 'pem', type: 'pkcs8' })
			.toString(),
		path = join(directory, 'apple.p8')
	await writeFile(path, pem)
	await choose(path)
	await expect(dialog()).toContainText('P-256 private key validated locally')
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	const box = await dialog()
		.getByRole('button', { name: 'Save provider credentials', exact: true })
		.boundingBox()
	expect(box!.y + box!.height).toBeLessThan(760)
	await mkdir('artifacts/validation-0.38.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.38.0/provider-apns-light.png' })
	await dialog().getByRole('button', { name: 'Save provider credentials', exact: true }).click()
	await expect(dialog()).toContainText('Provider update acknowledged')
	await expect(dialog()).not.toContainText(pem.split('\n')[1])
	expect(await readFile(path, 'utf8')).toBe(pem)
})
test('imports FCM v1 service accounts, exposes preview API guidance and never displays private contents', async () => {
	await connect()
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await open()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('fcm-v1')
	await expect(dialog()).toContainText('2023-10-01-preview')
	const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
			.privateKey.export({ type: 'pkcs8', format: 'pem' })
			.toString(),
		path = join(directory, 'firebase.json')
	await writeFile(
		path,
		JSON.stringify({
			type: 'service_account',
			project_id: 'fixture-project',
			client_email: 'sender@fixture-project.iam.gserviceaccount.com',
			private_key: key,
		}),
	)
	await choose(path)
	await expect(dialog()).toContainText('RSA service-account key validated locally')
	await expect(dialog()).toHaveCSS('background-color', 'rgb(44, 42, 38)')
	await page.screenshot({ path: 'artifacts/validation-0.38.0/provider-fcm-dark.png' })
	await send()
	await expect(dialog()).not.toContainText('sender@fixture-project')
	await expect(dialog()).not.toContainText(key.split('\n')[1])
})
test('rejects malformed certificate files and clears imports on provider changes', async () => {
	await connect()
	await open()
	await dialog()
		.getByLabel('Notification provider', { exact: true })
		.selectOption('apns-certificate')
	await dialog()
		.getByLabel('Certificate password (leave empty if none)', { exact: true })
		.fill('PRIVATE-PASSWORD')
	const path = join(directory, 'bad.p12')
	await writeFile(path, 'PRIVATE-CERTIFICATE')
	await choose(path)
	await expect(dialog().getByRole('alert')).toContainText('credential file is invalid')
	await expect(dialog()).not.toContainText('PRIVATE-CERTIFICATE')
	await expect(
		dialog().getByLabel('Certificate password (leave empty if none)', { exact: true }),
	).toHaveValue('')
	await expect(
		dialog().getByRole('button', { name: 'Save provider credentials', exact: true }),
	).toBeDisabled()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('apns-token')
	const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
		.privateKey.export({ format: 'pem', type: 'pkcs8' })
		.toString()
	await writeFile(path, key)
	await choose(path)
	await expect(dialog()).toContainText('P-256 private key validated locally')
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('adm')
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('apns-token')
	await expect(dialog()).not.toContainText('P-256 private key validated locally')
})
test('configures ADM and Baidu without persisting their secrets in profile storage', async () => {
	await connect()
	await open()
	for (const provider of ['adm', 'baidu']) {
		await dialog().getByLabel('Notification provider', { exact: true }).selectOption(provider)
		await dialog()
			.getByLabel(provider === 'adm' ? 'ADM client ID' : 'Baidu API key', { exact: true })
			.fill('PRIVATE-IDENTIFIER')
		await dialog()
			.getByLabel(provider === 'adm' ? 'ADM client secret' : 'Baidu secret key', {
				exact: true,
			})
			.fill('PRIVATE-SECRET')
		await send()
		await dialog().getByRole('button', { name: 'Close provider result' }).click()
		await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	}
	await dialog().getByRole('button', { name: 'Close provider credentials' }).click()
	const persisted = await readFile(join(directory, 'workspace.json'), 'utf8')
	expect(persisted).not.toContain('PRIVATE-SECRET')
	expect(persisted).not.toContain('PRIVATE-IDENTIFIER')
})
async function customHub(name: string) {
	await page.getByRole('button', { name: 'Create Notification Hub', exact: true }).click()
	await dialog().getByLabel('Hub name', { exact: true }).fill(name)
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this/ })
		.check()
	await dialog().getByRole('button', { name: 'Create Notification Hub', exact: true }).click()
	await dialog()
		.getByRole('button', { name: 'Close Notification Hubs result', exact: true })
		.click()
	await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('wns')
	await dialog().getByLabel('WNS Package SID', { exact: true }).fill('PRIVATE-SID')
	await dialog().getByLabel('WNS client secret', { exact: true }).fill('PRIVATE-SECRET')
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByRole('button', { name: 'Save provider credentials', exact: true }).click()
}
test('blocks further changes after a lost credential acknowledgment until explicit review', async () => {
	await connect()
	await customHub('unknown-provider')
	await expect(dialog().getByText('Provider outcome unknown', { exact: true })).toBeVisible()
	await expect(dialog()).not.toContainText('PRIVATE-SECRET')
	await dialog().getByRole('button', { name: 'Close provider result', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Provider credentials…', exact: true }),
	).toBeDisabled()
	await page.getByRole('button', { name: 'Check retained receipt', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Provider credentials…', exact: true }),
	).toBeDisabled()
	await page.getByRole('checkbox', { name: /I checked Azure state/ }).check()
	await expect(
		page.getByRole('button', { name: 'Provider credentials…', exact: true }),
	).toBeEnabled()
})
test('cancels an in-flight provider write and reports uncertainty without retrying', async () => {
	await connect()
	await customHub('write-slow-provider')
	await dialog().getByRole('button', { name: 'Cancel provider operation', exact: true }).click()
	await expect(dialog().getByText('Provider outcome unknown', { exact: true })).toBeVisible()
	await expect(dialog()).not.toContainText('PRIVATE-SECRET')
})

test('shows renewed Microsoft sign-in inside the provider modal with the operation log hidden', async () => {
	await connect()
	await hideOperations(page)
	await customHub('provider-renew')
	await expect(dialog().getByRole('region', { name: 'Provider Microsoft sign-in' })).toBeVisible()
	await expect(dialog()).toContainText('OFFLINE-PROVIDER')
	await expect(
		dialog().getByRole('button', { name: 'Open Microsoft sign-in', exact: true }),
	).toBeEnabled()
	await dialog().getByRole('button', { name: 'Cancel provider operation', exact: true }).click()
	await expect(dialog().getByText('Provider outcome unknown', { exact: true })).toBeVisible()
})
test('configures matching Browser keys and removes only the selected provider with fresh review', async () => {
	await connect()
	await open()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('browser')
	const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
		format: 'jwk',
	})
	const pub = Buffer.concat([
		Buffer.from([4]),
		Buffer.from(key.x!, 'base64url'),
		Buffer.from(key.y!, 'base64url'),
	]).toString('base64url')
	await dialog()
		.getByLabel('VAPID contact subject', { exact: true })
		.fill('mailto:push@example.com')
	await dialog().getByLabel('VAPID public key', { exact: true }).fill(pub)
	await dialog().getByLabel('VAPID private key', { exact: true }).fill(key.d!)
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 760))
	await mkdir('artifacts/validation-0.47.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.47.0/provider-browser-light.png' })
	await send()
	await dialog().getByRole('button', { name: 'Close provider result' }).click()
	await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('browser')
	await expect(dialog()).toContainText('Azure reports a credential object')
	await expect(dialog().getByLabel('VAPID private key', { exact: true })).toHaveValue('')
	await dialog()
		.getByRole('checkbox', { name: "Remove this provider's credentials", exact: true })
		.check()
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByRole('button', { name: 'Refresh provider status', exact: true }).click()
	await expect(dialog().getByRole('checkbox', { name: /I reviewed this hub/ })).not.toBeChecked()
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByRole('button', { name: 'Remove provider credentials', exact: true }).click()
	await expect(dialog()).toContainText('Azure acknowledged the provider removal request')
	await expect(dialog()).not.toContainText(key.d!)
	await dialog().getByRole('button', { name: 'Close provider result' }).click()
	await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('browser')
	await expect(dialog()).toContainText('Azure reports no credential object')
})
test('configures Xiaomi and offers retired GCM cleanup with explicit migration guidance', async () => {
	await connect()
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await open()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('xiaomi')
	await dialog().getByLabel('Xiaomi app secret', { exact: true }).fill('PRIVATE-XIAOMI')
	await dialog().getByLabel('Xiaomi regional endpoint', { exact: true }).fill('not a URL')
	await expect(
		dialog().getByRole('button', { name: 'Save provider credentials', exact: true }),
	).toBeDisabled()
	await dialog()
		.getByLabel('Xiaomi regional endpoint', { exact: true })
		.fill('https://api-eu.xmpush.xiaomi.com/v3/message/regid')
	await send()
	await dialog().getByRole('button', { name: 'Close provider result' }).click()
	await page.getByRole('button', { name: 'Provider credentials…', exact: true }).click()
	await dialog().getByLabel('Notification provider', { exact: true }).selectOption('gcm-legacy')
	await expect(dialog()).toContainText('GCM/FCM is retired')
	await expect(
		dialog().getByRole('button', { name: 'Import credential file…', exact: true }),
	).toHaveCount(0)
	await mkdir('artifacts/validation-0.47.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.47.0/provider-legacy-dark.png' })
	await dialog()
		.getByRole('checkbox', { name: /I reviewed this hub/ })
		.check()
	await dialog().getByRole('button', { name: 'Remove provider credentials', exact: true }).click()
	await expect(dialog()).toContainText('Provider update acknowledged')
})
