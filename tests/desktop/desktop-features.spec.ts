import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Uses the offline test host.')
let app: ElectronApplication, page: Page, directory: string
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-desktop-features-'))
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
	await page.getByLabel('Connection name', { exact: true }).fill('Desktop fixture')
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

test('shows retrieval progress immediately, respects reduced motion and clears after cancellation', async () => {
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await page.getByRole('button', { name: 'slow Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	const indicator = page.getByRole('status').filter({ hasText: 'Retrieving messages…' })
	await expect(indicator).toBeVisible()
	await expect(
		page.getByRole('button', { name: 'Retrieving messages…', exact: true }),
	).toBeDisabled()
	expect(
		await indicator
			.locator('.loading-spinner')
			.evaluate((element) => getComputedStyle(element).animationName),
	).toBe('none')
	await page.screenshot({ path: 'artifacts/message-retrieval-loading.png' })
	await page
		.getByRole('region', { name: 'Operations', exact: true })
		.getByRole('button', { name: 'Cancel', exact: true })
		.click()
	await expect(indicator).toHaveCount(0)
	await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
})

test('offers update checks through Preferences and the native Help menu', async () => {
	await app.evaluate(({ dialog }) => {
		Reflect.set(dialog, 'updateChecks', 0)
		dialog.showMessageBox = async (
			_window: Electron.BaseWindow | Electron.MessageBoxOptions,
			options?: Electron.MessageBoxOptions,
		) => {
			const value = options ?? _window
			if (!('message' in value) || value.message !== 'Updates unavailable')
				throw new Error('Expected an isolated-profile update notice')
			Reflect.set(dialog, 'updateChecks', Reflect.get(dialog, 'updateChecks') + 1)
			return { response: 0, checkboxChecked: false }
		}
	})
	await page.getByRole('button', { name: 'Preferences', exact: true }).click()
	await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled()
	const menu = await app.evaluate(({ Menu }) => {
		const item = Menu.getApplicationMenu()
			?.items.find((entry) => entry.label === 'Help')
			?.submenu?.items.find((entry) => entry.label === 'Check for updates…')
		item?.click()
		return !!item
	})
	expect(menu).toBe(true)
	await expect
		.poll(() => app.evaluate(({ dialog }) => Reflect.get(dialog, 'updateChecks')))
		.toBe(2)
})

test('provides current body tools, preferences and supported import formats', async () => {
	await expect(page.getByRole('button', { name: 'Generator plugins', exact: true })).toHaveCount(
		0,
	)
	await expect(page.getByRole('button', { name: 'Inspector plugins', exact: true })).toHaveCount(
		0,
	)
	const methods = await page.evaluate(() => Object.keys(window.commander))
	expect(methods).not.toEqual(expect.arrayContaining(['runInspector']))
	expect(
		methods.some((name) => /Legacy|Generated|generateDrafts|InspectorOutput/.test(name)),
	).toBe(false)
	await page.getByRole('button', { name: 'Preferences', exact: true }).click()
	await page.getByLabel('Default message subject', { exact: true }).fill('Modern default')
	await page.getByRole('button', { name: 'Save preferences', exact: true }).click()
	await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
	await page.getByRole('button', { name: 'Preferences', exact: true }).click()
	await expect(page.getByLabel('Default message subject', { exact: true })).toHaveValue(
		'Modern default',
	)
	await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
	await page.getByRole('button', { name: 'Body tools', exact: true }).click()
	const body = page.getByRole('dialog', { name: 'Body tools', exact: true })
	expect(
		await body
			.getByLabel('Codec body format', { exact: true })
			.locator('option')
			.evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
	).toEqual(['bytes', 'text'])
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Compose message', exact: true }).click()
	expect(
		await page
			.getByLabel('Import file format', { exact: true })
			.locator('option')
			.evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
	).toEqual(['archive', 'body'])
})

test('message selection survives sorting and copies/exports only the selected exact body', async () => {
	const previous = await app.evaluate(({ clipboard }) => clipboard.readText())
	try {
		const table = page.getByRole('table', { name: 'Messages', exact: true })
		await table
			.getByRole('checkbox', { name: 'Select message binary-002', exact: true })
			.check()
		await table
			.getByRole('button', { name: 'Sort loaded messages by Label (subject)', exact: true })
			.click()
		await expect(
			table.getByRole('checkbox', { name: 'Select message binary-002', exact: true }),
		).toBeChecked()
		await table
			.getByRole('checkbox', { name: 'Select message binary-002', exact: true })
			.focus()
		await page.keyboard.press('Control+c')
		await expect(
			page.getByRole('status').filter({ hasText: 'Copied 1 message(s).' }).first(),
		).toBeVisible()
		const copied = JSON.parse(await app.evaluate(({ clipboard }) => clipboard.readText()))
		expect(copied.messages).toHaveLength(1)
		expect(copied.messages[0].systemProperties).toContainEqual({
			name: 'MessageId',
			type: 'string',
			value: 'binary-002',
		})
		const file = join(directory, 'selected.msgc.json')
		await app.evaluate(({ dialog }, file) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
		}, file)
		await page.getByRole('button', { name: 'Export selected…', exact: true }).click()
		await expect(
			page.getByRole('status').filter({ hasText: 'Saved 1 message(s)' }).first(),
		).toBeVisible()
		expect(JSON.parse(await readFile(file, 'utf8')).messages).toEqual(copied.messages)
		const open = table.locator('[data-message-open]')
		await open.first().focus()
		await page.keyboard.press('End')
		await expect(open.last()).toBeFocused()
		await page.keyboard.press('Control+a')
		await expect(
			table.getByRole('checkbox', { name: 'Select all messages on this page', exact: true }),
		).toBeChecked()
		await page.keyboard.press('Escape')
		await expect(
			page.getByRole('button', { name: 'Export selected…', exact: true }),
		).toBeDisabled()
		await table
			.getByRole('checkbox', { name: 'Select message binary-002', exact: true })
			.check()
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		await expect(
			page.getByRole('button', { name: 'Export selected…', exact: true }),
		).toBeDisabled()
	} finally {
		await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous)
	}
})

test('keyboard command search, entity filtering and refresh work without replacing the loaded page', async () => {
	await page.keyboard.press('Control+k')
	const input = page.getByRole('combobox', { name: 'Search commands', exact: true })
	await input.fill('layout')
	await input.press('End')
	await expect(page.getByRole('option').last()).toHaveAttribute('aria-selected', 'true')
	await input.press('Home')
	await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
	await input.press('ArrowDown')
	await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
	await page.keyboard.press('Escape')
	await page.getByRole('button', { name: 'Hide entity tree', exact: true }).click()
	await page.keyboard.press('Control+f')
	await expect(page.getByLabel('Filter loaded entities', { exact: true })).toBeFocused()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('orders')
	await expect(page.getByRole('button', { name: 'orders Active', exact: true })).toBeVisible()
	await page.keyboard.press('F5')
	await expect(page.locator('.message-table tbody tr')).toHaveCount(2)
	await page.getByRole('button', { name: '9007199254740993 order-001', exact: true }).click()
	await page.keyboard.press('Control+f')
	await expect(page.getByRole('dialog', { name: 'Inspect message', exact: true })).toBeVisible()
})
test('entity tabs retain independent pages, support shortcuts and restore metadata without payloads', async () => {
	await page.getByLabel('Page size', { exact: true }).fill('1')
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await page.getByRole('button', { name: 'Peek next', exact: true }).click()
	await expect(page.locator('.message-table tbody')).toContainText('binary-002')
	const sequence = await page.getByLabel('From sequence', { exact: true }).inputValue()
	await page.getByRole('button', { name: 'empty Active', exact: true }).click()
	await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
	await expect(page.getByRole('tablist', { name: 'Open entities' }).getByRole('tab')).toHaveCount(
		2,
	)
	await page.getByRole('tab', { name: 'orders', exact: true }).click()
	await expect(page.getByLabel('From sequence', { exact: true })).toHaveValue(sequence)
	await expect(page.getByLabel('Page size', { exact: true })).toHaveValue('1')
	await expect(page.locator('.message-table tbody')).toContainText('binary-002')
	await page.keyboard.press('Control+PageDown')
	await expect(page.getByRole('tab', { name: 'empty', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	)
	const stored = await page.evaluate(() =>
		Object.keys(localStorage)
			.filter((key) => key.startsWith('commander-entity-tabs:'))
			.map((key) => localStorage.getItem(key))
			.join(''),
	)
	expect(stored).not.toMatch(/binary-002|900719925|snapshotId|SharedAccessKey|not-a-real-secret/)
	await page.reload()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
	await page
		.getByRole('button', { name: /Desktop fixture fixture.servicebus.windows.net/ })
		.click()
	await page.getByRole('button', { name: 'Connect and browse', exact: true }).click()
	await expect(page.getByRole('tablist', { name: 'Open entities' }).getByRole('tab')).toHaveCount(
		2,
	)
	await page.getByRole('tab', { name: 'orders', exact: true }).click()
	await expect(page.locator('.message-table')).toHaveCount(0)
	await page.getByRole('button', { name: 'Close entity tab empty', exact: true }).click()
	await expect(page.getByRole('tablist', { name: 'Open entities' }).getByRole('tab')).toHaveCount(
		1,
	)
})
test('large trees bound DOM rows and support keyboard navigation, filtering and selection', async () => {
	await page.evaluate(() => {
		const tree = (
			document.getElementById('app') as any
		).__vue_app__.config.globalProperties.$pinia._s.get('entity-tree')
		tree.branches.queue = {
			items: Array.from({ length: 5000 }, (_, index) => ({
				target: { kind: 'queue', name: 'q-' + String(index).padStart(5, '0') },
				status: 'Active',
				requiresSession: false,
			})),
			loaded: true,
			loading: false,
			error: '',
			continuationToken: null,
		}
	})
	const tree = page.getByRole('tree', { name: 'Namespace entities' })
	await expect(tree).toHaveClass(/virtual-entity-tree/)
	await expect.poll(() => tree.getByRole('treeitem').count()).toBeLessThan(80)
	await tree.focus()
	await page.keyboard.press('End')
	await expect(
		tree.getByRole('button', { name: 'order-events Active', exact: true }),
	).toBeFocused()
	await page.keyboard.press('Home')
	await expect(tree.getByRole('button', { name: 'Queues', exact: true })).toBeFocused()
	await page.keyboard.press('ArrowDown')
	await expect(tree.getByRole('button', { name: 'q-00000 Active', exact: true })).toBeFocused()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('04999')
	await expect(tree.getByRole('button', { name: 'q-04999 Active', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Select entities', exact: true }).click()
	await tree
		.getByRole('checkbox', { name: 'Select queue q-04999 for bulk actions', exact: true })
		.check()
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('00001')
	await page.getByLabel('Filter loaded entities', { exact: true }).fill('04999')
	await expect(
		tree.getByRole('checkbox', { name: 'Select queue q-04999 for bulk actions', exact: true }),
	).toBeChecked()
	await tree
		.getByRole('button', { name: 'q-04999 Active', exact: true })
		.click({ button: 'right' })
	await expect(page.getByRole('menuitem', { name: 'Send messages…', exact: true })).toBeVisible()
})
test('selected log export includes timestamps and redacts credentials while clearing keeps running work', async () => {
	const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
	try {
		await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
		await page.evaluate(() => {
			const workspace = (
				document.getElementById('app') as any
			).__vue_app__.config.globalProperties.$pinia._s.get('workspace')
			const job = workspace.jobs.find((job: any) => job.label === 'Peek messages')
			job.message = '2 messages · SharedAccessKey=PRIVATE-KEY; token=PRIVATE-TOKEN'
			job.code = 'DEVICE-CODE-PRIVATE'
		})
		const log = page.getByRole('region', { name: 'Operations', exact: true })
		await log
			.getByRole('checkbox', { name: 'Select log entry Peek messages', exact: true })
			.check()
		await log.getByRole('button', { name: 'Copy selected', exact: true }).click()
		const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
		expect(copied).toMatch(/\[\d{4}-\d{2}-\d{2}T.*\] COMPLETED Peek messages/)
		expect(copied).toContain('[redacted]')
		expect(copied).not.toMatch(
			/PRIVATE-KEY|PRIVATE-TOKEN|DEVICE-CODE-PRIVATE|Connect to namespace/,
		)
		const file = join(directory, 'selected.log')
		await app.evaluate(({ dialog }, file) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
		}, file)
		await log.getByRole('button', { name: 'Save selected…', exact: true }).click()
		await expect(log.getByRole('status')).toContainText('Saved selected.log')
		expect(await readFile(file, 'utf8')).toBe(copied)
		await log.getByRole('button', { name: 'Clear selected', exact: true }).click()
		await expect(
			log.getByRole('checkbox', { name: 'Select log entry Peek messages', exact: true }),
		).toHaveCount(0)
		await page.getByRole('button', { name: 'slow Active', exact: true }).click()
		await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
		await log
			.getByRole('checkbox', { name: 'Select log entry Peek messages', exact: true })
			.check()
		await log.getByRole('button', { name: 'Clear selected', exact: true }).click()
		await expect(log.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
		await log.getByRole('button', { name: 'Cancel', exact: true }).click()
		await expect(page.getByRole('button', { name: 'Peek messages', exact: true })).toBeEnabled()
	} finally {
		await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard)
	}
})
test('appearance persists and layout reset preserves connection and message pages', async () => {
	await page.getByRole('button', { name: 'Preferences', exact: true }).click()
	await page.getByLabel('Interface font', { exact: true }).selectOption('system')
	await page.getByLabel('Accent color', { exact: true }).selectOption('blue')
	await page.getByLabel('Interface size', { exact: true }).selectOption('1.25')
	await page.getByRole('button', { name: 'Save appearance', exact: true }).click()
	await expect(page.getByText('Appearance saved.', { exact: true })).toBeVisible()
	expect(
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
		),
	).toBe(1.25)
	await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
	await page.getByRole('button', { name: 'Reset layout', exact: true }).click()
	await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
	await expect(page.locator('.message-table tbody')).toContainText('order-001')
	await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
	await page.reload()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
	await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue')
	await expect
		.poll(() =>
			app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
			),
		)
		.toBe(1.25)
	await page.getByRole('button', { name: 'Preferences', exact: true }).click()
	await expect(page.getByLabel('Interface font', { exact: true })).toHaveValue('system')
	await page.getByRole('button', { name: 'Reset appearance', exact: true }).click()
	await page.getByRole('button', { name: 'Save appearance', exact: true }).click()
	await expect(page.locator('html')).toHaveAttribute('data-accent', 'warm')
	await expect
		.poll(() =>
			app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
			),
		)
		.toBe(1)
})
test('event partition tabs retain separate read results', async () => {
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Event tabs')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByLabel('Known Event Hub name', { exact: true }).fill('telemetry')
	await page.getByRole('button', { name: 'Connect Event Hubs', exact: true }).click()
	await page.getByRole('button', { name: 'telemetry $Default partition 0', exact: true }).click()
	await page.getByLabel('Event read count', { exact: true }).fill('7')
	await page.getByLabel('Event read time limit', { exact: true }).fill('12')
	await page.getByRole('button', { name: 'Read events', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Event read results' })).toContainText(
		'3 events read',
	)
	await page.getByRole('button', { name: 'telemetry $Default partition 1', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Event read results' })).toHaveCount(0)
	await expect(page.getByLabel('Event read count', { exact: true })).toHaveValue('25')
	await page.getByLabel('Read consumer group', { exact: true }).fill('isolated-reader')
	await page.getByLabel('Event start position', { exact: true }).selectOption('latest')
	await page.getByRole('tab', { name: 'telemetry / $Default / 0', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Event read results' })).toContainText(
		'3 events read',
	)
	await page.getByText('Configure event read', { exact: false }).click()
	await expect(page.getByLabel('Event read count', { exact: true })).toHaveValue('7')
	await expect(page.getByLabel('Event read time limit', { exact: true })).toHaveValue('12')
	await expect(page.getByLabel('Event start position', { exact: true })).toHaveValue('earliest')
	await expect(page.getByLabel('Read consumer group', { exact: true })).toHaveValue('$Default')
	await page
		.getByRole('button', { name: 'Close event tab telemetry / $Default / 1', exact: true })
		.click()
	await expect(
		page.getByRole('tablist', { name: 'Open event views' }).getByRole('tab'),
	).toHaveCount(1)
})
