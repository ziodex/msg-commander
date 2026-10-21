import { test as base, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const test = base.extend<{ rememberedProfile: boolean }>({
	rememberedProfile: [false, { option: true }],
})
let app: ElectronApplication
let page: Page
let directory: string
const packaged = process.env.COMMANDER_PACKAGED === '1'
function executable() {
	if (process.env.COMMANDER_PACKAGED_EXECUTABLE)
		return resolve(process.env.COMMANDER_PACKAGED_EXECUTABLE)
	if (process.platform === 'darwin')
		return resolve(
			`release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Msg Commander.app/Contents/MacOS/Msg Commander`,
		)
	if (process.platform === 'win32') return resolve('release/win-unpacked/msg-commander.exe')
	return resolve('release/linux-unpacked/msg-commander')
}
test.beforeEach(async ({ rememberedProfile }) => {
	directory = await mkdtemp(join(tmpdir(), 'commander-desktop-'))
	if (rememberedProfile) {
		await writeFile(
			join(directory, 'workspace.json'),
			JSON.stringify({
				version: 1,
				theme: 'system',
				profiles: [
					{
						profile: {
							id: 'cb12cbf2-9a04-494b-a456-8bce170d0c89',
							name: 'Remembered fixture',
							namespace: 'fixture.servicebus.windows.net',
							auth: 'sas',
							service: 'service-bus',
							tenantId: '',
							clientId: '',
						},
						// Deliberately unusable ciphertext: browsing must never try to decrypt it.
						encryptedSecret: Buffer.from('not-a-real-encrypted-credential').toString(
							'base64',
						),
					},
				],
			}),
		)
	}
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
		),
	)
	app = await electron.launch({
		...(packaged ? { executablePath: executable() } : {}),
		args: [...(packaged ? [] : ['.']), `--user-data-dir=${directory}`],
		env,
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

test('launches the isolated desktop, streams diagnostics, cancels and recovers', async () => {
	await expect(page).toHaveTitle('Msg Commander')
	expect(await app.evaluate(({ app }) => app.getName())).toBe('Msg Commander')
	await expect(page.locator('img.brand-mark')).toBeVisible()
	expect(
		await page
			.locator('img.brand-mark')
			.evaluate((image) => (image as HTMLImageElement).naturalWidth),
	).toBeGreaterThan(0)
	expect(
		await page.evaluate(() => ({
			node: typeof (window as unknown as { require?: unknown }).require,
			methods: Object.keys(window.commander),
		})),
	).toMatchObject({
		node: 'undefined',
		methods: expect.arrayContaining(['bootstrap', 'runOperation', 'onEvent']),
	})
	const preferences = await app.evaluate(({ BrowserWindow }) =>
		(
			BrowserWindow.getAllWindows()[0].webContents as unknown as {
				getLastWebPreferences(): Record<string, unknown>
			}
		).getLastWebPreferences(),
	)
	expect(preferences).toMatchObject({
		sandbox: true,
		contextIsolation: true,
		nodeIntegration: false,
	})
	if (await page.getByRole('button', { name: 'Show Operations log', exact: true }).count())
		await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
	await page.getByRole('button', { name: 'Run local diagnostics' }).click()
	await expect(page.getByText('Local diagnostics', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	await expect(page.getByText('cancelled', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Run local diagnostics' }).click()
	await expect(
		page.getByText(
			'Local runtime, framed IPC and progress delivery passed. No Azure request was made.',
		),
	).toBeVisible()
	await page.getByRole('button', { name: 'Restart backend', exact: true }).click()
	await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
	await page.screenshot({
		path: `test-results/${packaged ? 'packaged' : 'development'}-workspace.png`,
	})
})

test('saves a session-only profile, edits it, switches services and removes it', async () => {
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
	await expect(page.getByRole('heading', { name: 'Desktop fixture', exact: true })).toBeVisible()
	expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(
		'not-a-real-secret',
	)
	await expect(page.getByText('This session only', { exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
	await expect(page.getByLabel('Namespace connection string', { exact: true })).toHaveValue('')
	await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	await page.getByRole('button', { name: 'Event Hubs', exact: true }).click()
	await expect(page.getByRole('heading', { name: 'Event Hubs', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Service Bus', exact: true }).click()
	await page
		.getByRole('button', { name: 'Desktop fixture fixture.servicebus.windows.net' })
		.click()
	await page.getByRole('button', { name: 'Remove connection', exact: true }).click()
	await page
		.getByRole('dialog')
		.getByRole('button', { name: 'Remove connection', exact: true })
		.click()
	await expect(page.getByText('0 saved connections', { exact: true })).toBeVisible()
})

test('supports command search and persists the selected theme', async () => {
	await page.getByRole('button', { name: /Search commands/ }).click()
	await page.getByRole('combobox', { name: 'Search commands' }).fill('event grid')
	await page.getByRole('option', { name: 'Event Grid Service workspace' }).click()
	await expect(page.getByRole('heading', { name: 'Event Grid', exact: true })).toBeVisible()
	await page.getByRole('button', { name: /Switch to .* theme/ }).click()
	await expect
		.poll(async () => {
			try {
				return JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')).theme
			} catch {
				return undefined
			}
		})
		.toMatch(/^(dark|light)$/)
	const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
	expect(['dark', 'light']).toContain(saved.theme)
	await page.reload()
	await expect(page.locator('html')).toHaveClass(saved.theme === 'dark' ? 'dark' : '')
})

test.describe('credential store access is on demand', () => {
	test.use({ rememberedProfile: true })

	test('browses saved credentials and reloads without probing the OS store', async () => {
		const probes = await app.evaluateHandle(({ safeStorage }) => {
			const state = { count: 0 }
			safeStorage.isEncryptionAvailable = () => {
				state.count++
				throw new Error('Unexpected credential-store probe')
			}
			return state
		})
		await page.reload()
		await expect(page.getByText('Backend connected', { exact: true })).toBeVisible()
		await page
			.getByRole('button', {
				name: 'Remembered fixture fixture.servicebus.windows.net',
				exact: true,
			})
			.click()
		await expect(page.getByText('OS credential store', { exact: true })).toBeVisible()
		await page.getByRole('button', { name: 'Connection settings', exact: true }).click()
		await expect(page.getByLabel('Namespace connection string', { exact: true })).toHaveValue(
			'',
		)
		await page.getByRole('button', { name: 'Cancel', exact: true }).click()
		await page.getByRole('button', { name: /Switch to .* theme/ }).click()
		await page.getByRole('button', { name: 'Show Operations log', exact: true }).click()
		await page.getByRole('button', { name: 'Run local diagnostics' }).click()
		await expect(
			page.getByText(
				'Local runtime, framed IPC and progress delivery passed. No Azure request was made.',
			),
		).toBeVisible()
		expect(await probes.evaluate((state) => state.count)).toBe(0)
	})

	test('reports denied storage on save and allows session-only fallback', async () => {
		const probes = await app.evaluateHandle(({ safeStorage }) => {
			const state = { count: 0 }
			safeStorage.isEncryptionAvailable = () => {
				state.count++
				return false
			}
			return state
		})
		const before = await readFile(join(directory, 'workspace.json'), 'utf8')
		await page.getByRole('button', { name: 'New connection', exact: true }).click()
		await page.getByLabel('Connection name', { exact: true }).fill('Session fallback')
		await page
			.getByLabel('Namespace hostname', { exact: true })
			.fill('fixture.servicebus.windows.net')
		await page
			.getByLabel('Namespace connection string', { exact: true })
			.fill(
				'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=not-a-real-secret',
			)
		const remember = page.getByRole('checkbox', {
			name: 'Remember with the OS credential store',
		})
		await remember.check()
		expect(await probes.evaluate((state) => state.count)).toBe(0)
		await page.getByRole('button', { name: 'Save connection', exact: true }).click()
		await expect(page.getByRole('alert')).toHaveText(
			'Secure storage is unavailable. Use session-only credentials.',
		)
		await page.screenshot({ path: 'test-results/storage-unavailable.png' })
		expect(await probes.evaluate((state) => state.count)).toBe(1)
		expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(before)
		await remember.uncheck()
		await page.getByRole('button', { name: 'Save connection', exact: true }).click()
		await expect(
			page.getByRole('heading', { name: 'Session fallback', exact: true }),
		).toBeVisible()
		await expect(page.getByText('This session only', { exact: true })).toBeVisible()
		expect(await probes.evaluate((state) => state.count)).toBe(1)
		expect(await readFile(join(directory, 'workspace.json'), 'utf8')).not.toContain(
			'not-a-real-secret',
		)
	})
})
