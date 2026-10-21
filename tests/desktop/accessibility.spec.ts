import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test.skip(
	process.env.COMMANDER_PACKAGED === '1',
	'Offline content coverage; the packaged/native checks are separate.',
)

for (const theme of ['light', 'dark'] as const)
	for (const zoom of [1, 1.5]) {
		test(`accessible messaging controls in ${theme} at ${zoom * 100}%`, async () => {
			test.setTimeout(120000)
			const directory = await mkdtemp(join(tmpdir(), 'commander-accessibility-'))
			let app: ElectronApplication | undefined
			const reports: { state: string; violations: unknown[]; incomplete: unknown[] }[] = []
			try {
				const env = Object.fromEntries(
					Object.entries(process.env).filter(
						(entry): entry is [string, string] =>
							entry[0] !== 'ELECTRON_RUN_AS_NODE' && entry[1] !== undefined,
					),
				)
				app = await electron.launch({
					args: ['.', `--user-data-dir=${directory}`, '--force-renderer-accessibility'],
					env: { ...env, COMMANDER_TEST_HOST: '1' },
				})
				const page = await app.firstWindow()
				await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
					timeout: 20000,
				})
				await app.evaluate(({ BrowserWindow }) => {
					const window = BrowserWindow.getAllWindows()[0]!
					window.setContentSize(1280, 800)
				})
				await page.getByRole('button', { name: 'Preferences', exact: true }).click()
				await page.getByLabel('Interface size', { exact: true }).selectOption(String(zoom))
				await page.getByRole('button', { name: 'Save appearance', exact: true }).click()
				await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
				const dark = await page
					.locator('html')
					.evaluate((element) => element.classList.contains('dark'))
				if ((theme === 'dark') !== dark)
					await page
						.getByRole('button', {
							name:
								theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme',
							exact: true,
						})
						.click()
				await expect
					.poll(() =>
						page
							.locator('html')
							.evaluate((element) => element.classList.contains('dark')),
					)
					.toBe(theme === 'dark')
				async function audit(state: string) {
					const dialog = page.getByRole('dialog').last()
					if (await dialog.count()) {
						const focusable = await dialog
							.locator('a[href], button, input, select, textarea, [tabindex]')
							.evaluateAll(
								(elements) =>
									elements.filter((element) => {
										const control = element as HTMLElement & {
											disabled?: boolean
										}
										return (
											!control.disabled &&
											control.tabIndex >= 0 &&
											!!control.getClientRects().length
										)
									}).length,
							)
						// Walk past a complete cycle; background controls must remain unreachable.
						for (const key of [
							...Array<string>(focusable + 2).fill('Tab'),
							...Array<string>(focusable + 2).fill('Shift+Tab'),
						]) {
							await page.keyboard.press(key)
							await expect
								.poll(() =>
									dialog.evaluate((element) =>
										element.contains(document.activeElement),
									),
								)
								.toBe(true)
						}
					}
					const result = await new AxeBuilder({ page })
						.setLegacyMode(true)
						.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
						.analyze()
					reports.push({
						state,
						violations: result.violations.map(({ id, impact, description, nodes }) => ({
							id,
							impact,
							description,
							nodes: nodes.map(({ target, failureSummary }) => ({
								target,
								failureSummary,
							})),
						})),
						incomplete: result.incomplete.map(({ id, nodes }) => ({
							id,
							targets: nodes.map((node) => node.target),
						})),
					})
				}
				await audit('workspace')
				await page.getByRole('button', { name: 'Body tools', exact: true }).click()
				await audit('body tools options')
				const bodyTools = page.getByRole('dialog', { name: 'Body tools', exact: true })
				await bodyTools.getByLabel('Codec source body').fill('{"type":"OrderCreated"}')
				await bodyTools.getByRole('button', { name: 'Convert body', exact: true }).click()
				await expect(
					bodyTools.getByRole('region', { name: 'Converted body review' }),
				).toBeVisible()
				await audit('body tools result')
				await bodyTools
					.getByRole('button', { name: 'Close body codecs', exact: true })
					.click()
				await page.getByRole('button', { name: 'New connection', exact: true }).click()
				await audit('connection dialog')
				await page
					.getByLabel('Connection name', { exact: true })
					.fill('Accessibility fixture')
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
				await page.getByRole('button', { name: 'Expand queue orders', exact: true }).click()
				await page
					.getByRole('button', { name: 'Expand topic order-events', exact: true })
					.click()
				await expect(
					page.getByRole('button', { name: 'orders Messages', exact: true }),
				).toBeVisible()
				await audit('expanded entity tree')
				await page.getByRole('button', { name: 'orders Active', exact: true }).click()
				await page.getByRole('button', { name: 'Peek messages', exact: true }).click()
				await expect(page.locator('.message-table tbody tr')).toHaveCount(2)
				await audit('message list')
				await page.locator('[data-message-open]').first().click()
				await expect(page.getByTestId('message-body')).toBeVisible()
				await audit('message inspector')
				await page.keyboard.press('Escape')
				await page.getByRole('button', { name: 'Compose message', exact: true }).click()
				await audit('message composer')
				await page.keyboard.press('Escape')
				await page.getByRole('button', { name: 'Preferences', exact: true }).click()
				await audit('preferences')
				const failures = reports.filter((report) => report.violations.length)
				expect(failures.map(({ state, violations }) => ({ state, violations }))).toEqual([])
			} finally {
				await mkdir('artifacts/beta-accessibility', { recursive: true })
				await writeFile(
					`artifacts/beta-accessibility/${theme}-${zoom}.json`,
					JSON.stringify(reports, null, 2),
				)
				await app?.close()
				const target = resolve(directory)
				if (
					dirname(target) !== resolve(tmpdir()) ||
					!basename(target).startsWith('commander-accessibility-')
				)
					throw new Error('Unexpected accessibility cleanup directory')
				await rm(target, { recursive: true, force: true })
			}
		})
	}
