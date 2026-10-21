import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.skip(process.env.COMMANDER_PACKAGED === '1', 'Offline fixtures are excluded from installers.')
let app: ElectronApplication, page: Page, directory: string
const sas = (output = true) =>
	`https://fixturestore.blob.core.windows.net/registrations${output ? '' : '/input.txt'}?sv=2025-01-05&sr=${output ? 'c' : 'b'}&sp=${output ? 'rwl' : 'r'}&se=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}&spr=https&sig=SECRET-STORAGE-SAS`
const dialog = () =>
	page.getByRole('dialog', { name: 'Azure Storage registration jobs', exact: true })
const acknowledgment = () =>
	dialog().getByRole('checkbox', {
		name: 'I reviewed this hub, job action and Storage locations, including the full registration scope and any permanent changes.',
		exact: true,
	})
test.beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-nh-jobs-'))
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
})
test.afterEach(async () => {
	await app?.close()
	if (directory) await rm(directory, { recursive: true, force: true })
})
async function browse(hub = 'alerts') {
	await page.getByRole('button', { name: 'New connection', exact: true }).click()
	await page.getByLabel('Connection name', { exact: true }).fill('Offline jobs')
	await page
		.getByLabel('Namespace hostname', { exact: true })
		.fill('fixture.servicebus.windows.net')
	await page.getByRole('radio', { name: 'Connection string', exact: true }).check()
	await page
		.getByLabel('Namespace connection string', { exact: true })
		.fill(
			'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;',
		)
	await page.getByRole('button', { name: 'Save connection', exact: true }).click()
	await page.getByRole('button', { name: 'Browse registrations…', exact: true }).click()
	await page.getByLabel('Registration hub name', { exact: true }).fill(hub)
	await page.getByRole('button', { name: 'Connect registrations', exact: true }).click()
	await expect(
		page.getByRole('row', { name: 'Registration apple-native', exact: true }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Azure Storage jobs…', exact: true }).click()
}
async function review(type = 'ExportRegistrations') {
	await dialog().getByLabel('Bulk job action', { exact: true }).selectOption(type)
	if (type !== 'ExportRegistrations')
		await dialog().getByLabel('Input blob SAS URL', { exact: true }).fill(sas(false))
	await dialog().getByLabel('Output container SAS URL', { exact: true }).fill(sas())
	await dialog().getByRole('button', { name: 'Review bulk job', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Bulk job review', exact: true }),
	).toBeVisible()
}
async function submit() {
	await acknowledgment().check()
	await dialog().getByRole('button', { name: 'Submit reviewed Azure job', exact: true }).click()
}
test('reviews an export, clears tokens, retains acceptance and refreshes Azure completion', async () => {
	await browse()
	await expect(dialog().getByLabel('Output container SAS URL', { exact: true })).toHaveAttribute(
		'type',
		'password',
	)
	await review()
	await expect(
		dialog().getByRole('button', { name: 'Submit reviewed Azure job', exact: true }),
	).toBeDisabled()
	await expect(dialog()).toContainText('Exports every registration in this hub')
	expect(await dialog().innerText()).not.toContain('SECRET')
	await mkdir('artifacts/validation-0.48.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.48.0/jobs-export-review-light.png' })
	await submit()
	const receipt = dialog().getByRole('region', {
		name: 'Bulk job submission receipt',
		exact: true,
	})
	await expect(receipt).toContainText('accepted')
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk job details', exact: true }),
	).toContainText('Running')
	await expect(dialog().getByLabel('Output container SAS URL', { exact: true })).toHaveValue('')
	await dialog().getByRole('button', { name: 'Refresh selected job', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk job details', exact: true }),
	).toContainText('Completed')
	await expect(receipt).toContainText('accepted')
	await dialog().getByRole('button', { name: 'Refresh Azure jobs', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk jobs', exact: true }),
	).toContainText('2 returned jobs')
	expect(await dialog().innerText()).not.toContain('SECRET')
	await dialog().getByRole('button', { name: 'Close Azure jobs', exact: true }).click()
	await page.getByRole('button', { name: 'Azure Storage jobs…', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Bulk job submission receipt', exact: true }),
	).toContainText('accepted')
	await dialog()
		.getByRole('button', { name: 'Check retained bulk job receipt', exact: true })
		.click()
})
test('reviews deletion explicitly and invalidates acknowledgment when changing the job', async () => {
	await browse()
	await review('ImportDeleteRegistrations')
	await expect(dialog()).toContainText('permanently deletes registrations')
	await acknowledgment().check()
	await dialog().getByRole('button', { name: 'Change bulk job', exact: true }).click()
	await expect(dialog().getByLabel('Input blob SAS URL', { exact: true })).toHaveValue('')
	await review('ImportUpdateRegistrations')
	await expect(acknowledgment()).not.toBeChecked()
	await expect(dialog()).toContainText('can replace existing registrations')
	await submit()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk job details', exact: true }),
	).toContainText('Update registrations from Storage')
})
test('keeps a lost response uncertain, discovers the Azure job and gates another submission', async () => {
	await browse('job-uncertain')
	await review()
	await submit()
	await expect(
		dialog().getByRole('region', { name: 'Bulk job submission receipt', exact: true }),
	).toContainText('unknown')
	await expect(
		dialog().getByRole('button', { name: 'Review bulk job', exact: true }),
	).toBeDisabled()
	await dialog().getByRole('button', { name: 'Refresh Azure jobs', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk jobs', exact: true }),
	).toContainText('job-1')
	await dialog()
		.getByRole('button', { name: 'Check retained bulk job receipt', exact: true })
		.click()
	await dialog()
		.getByRole('checkbox', {
			name: 'I checked Azure jobs and reviewed the uncertain submission before another job.',
			exact: true,
		})
		.check()
	await expect(
		dialog().getByRole('button', { name: 'Review bulk job', exact: true }),
	).toBeEnabled()
})
test('cancels a local submission without claiming that Azure stopped its job', async () => {
	await browse('job-slow')
	await review()
	await submit()
	await expect(
		dialog().getByRole('button', { name: 'Cancel local job request', exact: true }),
	).toBeVisible()
	await page.waitForTimeout(150)
	await dialog().getByRole('button', { name: 'Cancel local job request', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Bulk job submission receipt', exact: true }),
	).toContainText('unknown')
	await expect(dialog()).toContainText('cannot stop an accepted job')
	await dialog().getByRole('button', { name: 'Refresh Azure jobs', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk jobs', exact: true }),
	).toContainText('job-1')
})
test('validates URLs locally and looks up a known Azure job ID', async () => {
	await browse()
	await dialog()
		.getByLabel('Output container SAS URL', { exact: true })
		.fill(sas().replace('sp=rwl', 'sp=r'))
	await dialog().getByRole('button', { name: 'Review bulk job', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText('write/list')
	expect(await dialog().innerText()).not.toContain('SECRET')
	await dialog().getByLabel('Azure job ID', { exact: true }).fill('../jobs')
	await dialog().getByRole('button', { name: 'Look up Azure job', exact: true }).click()
	await expect(dialog().getByRole('alert')).toContainText('letters, digits')
	await dialog().getByLabel('Azure job ID', { exact: true }).fill('existing-job')
	await dialog().getByRole('button', { name: 'Look up Azure job', exact: true }).click()
	await expect(
		dialog().getByRole('region', { name: 'Azure bulk job details', exact: true }),
	).toContainText('Completed')
})
test('keeps dark-theme import review and actions usable in a small window', async () => {
	await browse()
	await dialog().getByRole('button', { name: 'Close Azure jobs', exact: true }).click()
	await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
	await page.setViewportSize({ width: 1120, height: 760 })
	await page.getByRole('button', { name: 'Azure Storage jobs…', exact: true }).click()
	await review('ImportCreateRegistrations')
	const box = await dialog().boundingBox()
	expect(box!.y).toBeGreaterThanOrEqual(0)
	expect(box!.y + box!.height).toBeLessThanOrEqual(760)
	await acknowledgment().scrollIntoViewIfNeeded()
	await acknowledgment().check()
	await expect(
		dialog().getByRole('button', { name: 'Close Azure jobs', exact: true }),
	).toBeInViewport()
	await mkdir('artifacts/validation-0.48.0', { recursive: true })
	await page.screenshot({ path: 'artifacts/validation-0.48.0/jobs-import-review-dark.png' })
})
