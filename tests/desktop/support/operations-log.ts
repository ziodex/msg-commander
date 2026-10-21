import { expect, type Page } from '@playwright/test'

export async function showOperations(page: Page) {
	// Always make an explicit choice, including when auto mode currently shows the panel.
	await page.getByRole('button', { name: /^(Show|Hide) Operations log$/, exact: true }).click()
	const show = page.getByRole('button', { name: 'Show Operations log', exact: true })
	if (await show.count()) await show.click()
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).toBeVisible()
}

// Explicitly pin closed so an automatic idle collapse does not reopen on the next job.
export async function hideOperations(page: Page) {
	await showOperations(page)
	await page.getByRole('button', { name: 'Hide Operations log', exact: true }).click()
	await expect(page.getByRole('region', { name: 'Operations', exact: true })).not.toBeVisible()
}
