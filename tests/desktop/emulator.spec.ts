import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

test.skip(process.env.COMMANDER_EMULATOR !== '1', 'Opt-in real Docker emulator integration.')
test('Windows desktop connects to Docker, sends/inspects JSON, copies/exports selection and completes a delivery', async () => {
	test.setTimeout(90000)
	const directory = await mkdtemp(join(tmpdir(), 'commander-emulator-'))
	let app: ElectronApplication | undefined, previous: string | undefined
	try {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		const executable = process.env.COMMANDER_PACKAGED_EXECUTABLE
		app = await electron.launch({
			...(executable ? { executablePath: resolve(executable) } : {}),
			args: [...(executable ? [] : ['.']), `--user-data-dir=${directory}`],
			env,
		})
		const page = await app.firstWindow()
		previous = await app.evaluate(({ clipboard }) => clipboard.readText())
		await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
			timeout: 20000,
		})
		await page.getByRole('button', { name: 'New connection', exact: true }).click()
		await page.getByLabel('Local emulator', { exact: true }).check()
		await expect(page.getByLabel('Namespace hostname', { exact: true })).toHaveValue(
			'localhost',
		)
		await page.getByRole('button', { name: 'Save connection', exact: true }).click()
		await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
		const queue = `desktop-${randomUUID()}`
		await expect(
			page.getByRole('button', { name: 'desktop-messages Active', exact: true }),
		).toBeVisible()
		await page.getByRole('button', { name: 'desktop-messages Active', exact: true }).click()
		await page.locator('.entity-admin > summary').click()
		await page.getByRole('button', { name: 'Create queue', exact: true }).click()
		const creation = page.getByRole('dialog')
		await creation.getByLabel('Entity name', { exact: true }).fill(queue)
		await creation.getByLabel('Default message TTL', { exact: true }).fill('01:00:00')
		await creation.getByRole('button', { name: 'Create queue', exact: true }).click()
		await expect(creation).toHaveCount(0)
		const id = `desktop-${randomUUID()}`
		const body = '{"n":9007199254740993,"city":"Málaga 🚀"}'
		await page.getByRole('button', { name: 'Compose message', exact: true }).click()
		let dialog = page.getByRole('dialog')
		await dialog.getByLabel('Message ID', { exact: true }).fill(id)
		await dialog.getByLabel('Message body', { exact: true }).fill(body)
		await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
		await expect(dialog).toHaveCount(0)
		await expect(page.locator('.operation-outcome')).toContainText('CONFIRMED')
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		const table = page.getByRole('table', { name: 'Messages', exact: true })
		await table
			.locator('tbody tr')
			.filter({ hasText: id })
			.locator('[data-message-open]')
			.click()
		dialog = page.getByRole('dialog', { name: 'Inspect message', exact: true })
		await expect(dialog.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		await expect(dialog.getByTestId('message-body')).toContainText('9007199254740993')
		await page.screenshot({ path: 'artifacts/emulator-message-inspector.png' })
		await page.keyboard.press('Escape')
		await table.getByRole('checkbox', { name: `Select message ${id}`, exact: true }).check()
		await page.getByRole('button', { name: 'Copy selected', exact: true }).click()
		await expect(
			page.getByRole('status').filter({ hasText: 'Copied 1 message(s).' }).first(),
		).toBeVisible()
		const copied = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()))
		expect(copied.messages).toHaveLength(1)
		expect(Buffer.from(copied.messages[0].bodyBase64, 'base64').toString('utf8')).toBe(body)
		const path = join(directory, 'selected.msgc.json')
		await app.evaluate(({ dialog }, path) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
		}, path)
		await page.getByRole('button', { name: 'Export selected…', exact: true }).click()
		await expect(
			page.getByRole('status').filter({ hasText: 'Saved 1 message(s)' }).first(),
		).toBeVisible()
		expect(JSON.parse(await readFile(path, 'utf8')).messages).toEqual(copied.messages)
		await page.getByRole('button', { name: 'Receive and lock', exact: true }).click()
		const item = page.getByRole('article', { name: `Received ${id}`, exact: true })
		await expect(item).toBeVisible()
		await item.getByRole('button', { name: 'Complete', exact: true }).click()
		await page
			.getByRole('dialog')
			.getByRole('button', { name: 'Confirm complete', exact: true })
			.click()
		await expect(item).toContainText('completed')
		await expect(page.locator('footer')).toContainText('Local emulator')
		await page.screenshot({ path: 'artifacts/emulator-desktop.png' })
		await page.getByRole('button', { name: 'Close receiver', exact: true }).click()
		await page
			.getByRole('dialog', { name: 'Close receiver', exact: true })
			.getByRole('button', { name: 'Close and let locks expire', exact: true })
			.click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		const management = page.locator('.entity-admin')
		if (!(await management.evaluate((element) => (element as HTMLDetailsElement).open)))
			await management.locator('summary').click()
		await page.getByRole('button', { name: 'Delete queue', exact: true }).click()
		await expect(page.getByRole('dialog').locator('.write-destination')).toContainText(queue)
		await page
			.getByRole('dialog')
			.getByRole('checkbox', {
				name: 'I understand this queue and all its messages will be permanently deleted.',
				exact: true,
			})
			.check()
		await page
			.getByRole('dialog')
			.getByRole('button', { name: 'Permanently delete queue', exact: true })
			.click()
		await expect(page.getByRole('dialog')).toHaveCount(0)
		await page.getByRole('button', { name: 'New connection', exact: true }).click()
		await expect(page.getByLabel('Local emulator', { exact: true })).not.toBeChecked()
		await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	} finally {
		if (app && previous !== undefined)
			await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous)
		await app?.close()
		await rm(directory, { recursive: true, force: true })
	}
})
