import { defineConfig } from 'vitest/config'
export default defineConfig({
	test: {
		include: ['tests/emulator/**/*.test.ts'],
		testTimeout: 60000,
		hookTimeout: 30000,
		fileParallelism: false,
	},
})
