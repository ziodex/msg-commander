import { defineConfig } from '@playwright/test'
export default defineConfig({
	testDir: 'tests/desktop',
	fullyParallel: false,
	workers: 1,
	timeout: 30000,
	reporter: 'list',
	use: { trace: 'retain-on-failure' },
})
