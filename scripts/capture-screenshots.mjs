import { mkdtemp, mkdir, access, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
await access(join(root, 'out/main/index.js'))
await access(join(root, 'tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'))
const output = join(root, 'docs/images')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'msg-readme-'))
let app
try {
	await writeFile(
		join(profile, 'workspace.json'),
		JSON.stringify({ version: 1, theme: 'light', profiles: [] }),
	)
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
		),
	)
	// The offline host rejects real namespaces; every message below is synthetic.
	app = await electron.launch({
		cwd: root,
		args: ['.', `--user-data-dir=${profile}`],
		env: { ...env, COMMANDER_TEST_HOST: '1' },
	})
	const page = await app.firstWindow()
	await app.evaluate(({ BrowserWindow }) => {
		BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
	})
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
		timeout: 20000,
	})
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Orders demo')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeEnabled()
	await page.locator('.entity-admin > summary').click()
	await page.getByRole('button', { name: 'Create queue', exact: true }).click()
	let dialog = page.getByRole('dialog')
	await dialog.getByLabel('Entity name', { exact: true }).fill('demo-orders')
	await dialog.getByRole('button', { name: 'Create queue', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await page.locator('.entity-admin > summary').click()
	await page.getByPlaceholder('Find an entity…').fill('order')
	await page.getByRole('button', { name: 'demo-orders Active', exact: true }).click()
	for (let index = 0; index < 6; index++) {
		await page.getByRole('button', { name: 'Compose message', exact: true }).click()
		dialog = page.getByRole('dialog')
		await dialog.getByLabel('Message ID', { exact: true }).fill(`order-${1042 + index}`)
		await dialog.getByLabel('Message subject', { exact: true }).fill('Order placed')
		await dialog.getByLabel('Content type', { exact: true }).fill('application/json')
		await dialog.getByLabel('Message body', { exact: true }).fill(
			JSON.stringify(
				{
					event: 'order.created',
					orderId: `ORD-${1042 + index}`,
					customerId: 'CUST-042',
					region: 'EU',
					quantity: 3,
					total: 149.95,
					currency: 'EUR',
					expedited: false,
				},
				null,
				2,
			),
		)
		await dialog.getByRole('button', { name: 'Add property', exact: true }).click()
		await dialog.getByLabel('Property name 1', { exact: true }).fill('source')
		await dialog.getByLabel('Property value 1', { exact: true }).fill('checkout')
		await dialog.getByRole('button', { name: 'Add property', exact: true }).click()
		await dialog.getByLabel('Property name 2', { exact: true }).fill('schemaVersion')
		await dialog.getByLabel('Property type 2', { exact: true }).selectOption('int32')
		await dialog.getByLabel('Property value 2', { exact: true }).fill('1')
		await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(dialog).toHaveCount(0)
	}
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table tbody tr')).toHaveCount(6)
	await page.getByRole('button', { name: 'Namespace statistics' }).click()
	await page.getByRole('button', { name: 'Refresh namespace counts', exact: true }).click()
	await expect(
		page
			.locator('.tree-row')
			.filter({ has: page.getByRole('button', { name: 'demo-orders Active', exact: true }) })
			.getByTitle('Active messages', { exact: true }),
	).toHaveText('6')
	await page.getByRole('button', { name: 'Namespace statistics' }).click()
	await page.evaluate(() => document.fonts.ready)
	await page.mouse.move(0, 0)
	await page.screenshot({ path: join(output, 'workspace-light.png'), animations: 'disabled' })
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Switch to light theme', exact: true }),
	).toBeVisible()
	await page
		.locator('.message-table')
		.getByRole('button', { name: /order-1042/ })
		.click()
	dialog = page.getByRole('dialog', { name: 'Inspect message', exact: true })
	await expect(dialog.getByTestId('message-body')).toContainText('ORD-1042')
	await page.mouse.move(0, 0)
	await page.screenshot({
		path: join(output, 'message-inspector-dark.png'),
		animations: 'disabled',
	})
	console.log(`Saved screenshots to ${resolve(output)}`)
} finally {
	try {
		await app?.close()
	} finally {
		await rm(profile, { recursive: true, force: true })
	}
}
