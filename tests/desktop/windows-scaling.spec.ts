import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test.skip(
	process.platform !== 'win32' || process.env.COMMANDER_WINDOWS_SCALING !== '1',
	'Windows display-scaling qualification opt-in required.',
)

for (const scale of [1, 1.25, 1.5, 2]) {
	test(`keeps startup and native-backed forms usable at ${scale * 100}% device scaling`, async () => {
		test.setTimeout(60000)
		if (!process.env.COMMANDER_PACKAGED_EXECUTABLE)
			throw new Error('Set the Windows executable under test.')
		const directory = await mkdtemp(join(tmpdir(), 'commander-windows-scaling-'))
		let app: ElectronApplication | undefined
		let observation: unknown
		try {
			const env = Object.fromEntries(
				Object.entries(process.env).filter(
					(entry): entry is [string, string] =>
						!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
						entry[1] !== undefined,
				),
			)
			app = await electron.launch({
				executablePath: resolve(process.env.COMMANDER_PACKAGED_EXECUTABLE),
				args: [`--user-data-dir=${directory}`, `--force-device-scale-factor=${scale}`],
				env,
			})
			const page = await app.firstWindow()
			await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
				timeout: 20000,
			})
			const geometry = await app.evaluate(({ BrowserWindow, screen, app }) => {
				const window = BrowserWindow.getAllWindows()[0]!,
					bounds = window.getBounds(),
					display = screen.getDisplayMatching(bounds)
				return {
					version: app.getVersion(),
					bounds,
					workArea: display.workArea,
					scaleFactor: display.scaleFactor,
					minimum: window.getMinimumSize(),
				}
			})
			const pixelRatio = await page.evaluate(() => window.devicePixelRatio)
			observation = { requestedScale: scale, geometry, pixelRatio }
			expect(geometry.scaleFactor).toBeCloseTo(scale, 1)
			expect(pixelRatio).toBeCloseTo(scale, 1)
			expect(geometry.bounds.x).toBeGreaterThanOrEqual(geometry.workArea.x)
			expect(geometry.bounds.y).toBeGreaterThanOrEqual(geometry.workArea.y)
			expect(geometry.bounds.x + geometry.bounds.width).toBeLessThanOrEqual(
				geometry.workArea.x + geometry.workArea.width,
			)
			expect(geometry.bounds.y + geometry.bounds.height).toBeLessThanOrEqual(
				geometry.workArea.y + geometry.workArea.height,
			)
			await page.getByRole('button', { name: 'Body tools', exact: true }).click()
			const body = page.getByRole('dialog', { name: 'Body tools', exact: true })
			await expect(body.getByRole('combobox')).toHaveCount(5)
			await body.getByLabel('Codec source body').fill('{"type":"ScaleCheck"}')
			await body.getByRole('button', { name: 'Convert body', exact: true }).click()
			await expect(body.getByRole('region', { name: 'Converted body review' })).toContainText(
				'ScaleCheck',
			)
			await body.getByRole('button', { name: 'Close body codecs', exact: true }).click()
			await page.getByRole('button', { name: 'Preferences', exact: true }).click()
			await expect(page.getByLabel('Interface size', { exact: true })).toBeVisible()
			await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
			await page.getByRole('button', { name: 'New connection', exact: true }).click()
			await expect(page.getByLabel('Connection name', { exact: true })).toBeVisible()
			await page.keyboard.press('Escape')
			await mkdir('artifacts/beta-windows-scaling', { recursive: true })
			await page.screenshot({ path: `artifacts/beta-windows-scaling/${scale}.png` })
		} finally {
			await mkdir('artifacts/beta-windows-scaling', { recursive: true })
			await writeFile(
				`artifacts/beta-windows-scaling/${scale}.json`,
				JSON.stringify(observation ?? {}, null, 2),
			)
			await app?.close()
			const target = resolve(directory)
			if (
				dirname(target) !== resolve(tmpdir()) ||
				!basename(target).startsWith('commander-windows-scaling-')
			)
				throw new Error('Unexpected scaling cleanup directory')
			await rm(target, { recursive: true, force: true })
		}
	})
}
