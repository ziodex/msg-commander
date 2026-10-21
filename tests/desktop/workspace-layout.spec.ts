import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(process.env.COMMANDER_PACKAGED === '1', 'Uses the offline test host.')
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-layout-'))
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
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
	await page.getByLabel('Connection name', { exact: true }).fill('Layout fixture')
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
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.locator('.message-table tbody tr')).toHaveCount(2)
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})

test('compact workspace prioritizes messages and discloses statistics and namespace commands', async () => {
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720),
	)
	await expect(
		page.getByRole('button', { name: 'Namespace statistics', exact: false }),
	).toHaveAttribute('aria-expanded', 'false')
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).not.toBeVisible()
	await expect(page.locator('.message-table tbody tr').last()).toBeInViewport()
	await page.getByRole('button', { name: 'Namespace statistics', exact: false }).click()
	await expect(page.getByLabel('Active messages count', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Namespace statistics', exact: false }).click()
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await expect(page.getByRole('menuitem', { name: 'Bulk entities…', exact: true })).toBeVisible()
	await page.getByRole('menuitem', { name: 'Service Bus configuration…', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Service Bus configuration', exact: true })
	await expect(dialog).toBeVisible()
	await page.keyboard.press('Escape')
	await expect(dialog).not.toBeVisible()
	await page.getByRole('button', { name: 'Actions', exact: true }).click()
	await page.getByRole('menuitem', { name: 'Bulk entities…', exact: true }).click()
	await expect(
		page.getByRole('dialog', { name: 'Bulk entity actions', exact: true }),
	).toBeVisible()
})

test('entities divider supports dragging, keyboard resizing, hide/show and saved widths', async () => {
	const divider = page.getByRole('separator', { name: 'Resize entities column', exact: true })
	const tree = page.getByRole('complementary', { name: 'Entities', exact: true })
	const initial = (await tree.boundingBox())!.width
	const bounds = (await divider.boundingBox())!
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30)
	await page.mouse.down()
	await page.mouse.move(bounds.x + 80, bounds.y + 30, { steps: 8 })
	await page.mouse.up()
	await expect.poll(async () => (await tree.boundingBox())!.width).toBeGreaterThan(initial + 50)
	const dragged = (await tree.boundingBox())!.width
	await divider.focus()
	await page.keyboard.press('ArrowLeft')
	await expect.poll(async () => (await tree.boundingBox())!.width).toBeLessThan(dragged)
	const saved = (await tree.boundingBox())!.width
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem('reka:commander-service-bus-entities-v1')),
		)
		.toBeTruthy()
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await expect(tree).not.toBeVisible()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect
		.poll(async () => Math.abs((await tree.boundingBox())!.width - saved))
		.toBeLessThan(3)
	const ratio = Number(await divider.getAttribute('aria-valuenow'))
	await expect
		.poll(() =>
			page.evaluate(() => {
				const state = JSON.parse(
					localStorage.getItem('reka:commander-service-bus-entities-v1') ?? '{}',
				)
				return (Object.values(state)[0] as { layout: number[] } | undefined)?.layout[0]
			}),
		)
		.toBeCloseTo(ratio, 0)
	await page.reload()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: /Layout fixture fixture.servicebus.windows.net/ })
		.click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await expect(tree).toBeVisible()
	await expect
		.poll(async () => Math.abs((await tree.boundingBox())!.width - saved))
		.toBeLessThan(3)
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem('commander-tree-visible')))
		.toBe('false')
	await page.reload()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: /Layout fixture fixture.servicebus.windows.net/ })
		.click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Show entity tree', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Show entity tree', exact: true }).click()
	await expect
		.poll(async () => Math.abs((await tree.boundingBox())!.width - saved))
		.toBeLessThan(3)
})

test('message columns resize and persist, while sorting exact sequences only changes the loaded page', async () => {
	const rows = page.locator('.message-table tbody tr')
	await page
		.getByRole('button', { name: 'Sort loaded messages by Sequence / message ID', exact: true })
		.click()
	await expect(rows.first()).toContainText('9007199254740993')
	await page
		.getByRole('button', { name: 'Sort loaded messages by Sequence / message ID', exact: true })
		.click()
	await expect(rows.first()).toContainText('9007199254740996')
	await expect(page.getByText('Sorted within this page', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: 'Sort loaded messages by Sequence / message ID', exact: true })
		.click()
	await expect(rows.first()).toContainText('9007199254740993')
	const handle = page.getByRole('separator', {
		name: 'Resize Label (subject) column',
		exact: true,
	})
	const width = Number(await handle.getAttribute('aria-valuenow'))
	await handle.focus()
	await page.keyboard.press('Shift+ArrowRight')
	await expect
		.poll(async () => Number(await handle.getAttribute('aria-valuenow')))
		.toBeGreaterThan(width)
	const bounds = (await handle.boundingBox())!
	await page.mouse.move(bounds.x + 4, bounds.y + 12)
	await page.mouse.down()
	await page.mouse.move(bounds.x + 65, bounds.y + 12, { steps: 6 })
	await page.mouse.up()
	const saved = await handle.getAttribute('aria-valuenow')
	expect(Number(saved)).toBeGreaterThan(width + 50)
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(handle).toHaveAttribute('aria-valuenow', saved!)
})

test('operations open for running work and collapse when idle unless explicitly kept open', async () => {
	test.setTimeout(60000) // Three deliberately slow fixture reads each take ten seconds.
	const log = page.getByRole('region', { name: 'Operations', exact: true })
	await expect(log).not.toBeVisible()
	await page.getByRole('button', { name: 'slow Active', exact: true }).click()
	await page.getByLabel('Page size', { exact: true }).fill('1')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(log).toBeVisible()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled({
		timeout: 15000,
	})
	await expect(log).not.toBeVisible()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(log).toBeVisible()
	await page.getByRole('button', { name: 'Hide Operations log', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled({
		timeout: 15000,
	})
	await expect(log).not.toBeVisible()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled({
		timeout: 15000,
	})
	await expect(log).not.toBeVisible()
	await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await page.getByRole('button', { name: 'orders Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
	await expect(log).toBeVisible()
})
