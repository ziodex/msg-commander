import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
	main: {
		build: {
			externalizeDeps: false,
			rollupOptions: {
				external: ['electron-updater'],
				input: {
					index: resolve('src/main/index.ts'),
				},
			},
		},
	},
	preload: { build: { externalizeDeps: false } },
	renderer: {
		resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
		plugins: [vue(), tailwindcss()],
	},
})
