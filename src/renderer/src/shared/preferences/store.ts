import { preferencesApi } from '@/shared/preferences/api'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
	desktopPreferencesSchema,
	defaultDesktopPreferences,
	type DesktopPreferences,
} from '@shared/desktop-tools'
const storageKey = 'commander-desktop-preferences-v1'
export const useDesktopPreferences = defineStore('desktop-preferences', () => {
	const preferences = ref<DesktopPreferences>({ ...defaultDesktopPreferences })
	try {
		preferences.value = desktopPreferencesSchema.parse(
			JSON.parse(localStorage.getItem(storageKey) ?? 'null'),
		)
	} catch {
		// Use defaults for missing or older settings.
	}
	function apply() {
		const fonts = {
			plex: "'IBM Plex Sans', 'Segoe UI', sans-serif",
			system: "system-ui, 'Segoe UI', sans-serif",
			mono: "'Cascadia Code', Consolas, monospace",
		}
		document.documentElement.style.setProperty(
			'--interface-font',
			fonts[preferences.value.font],
		)
		document.documentElement.dataset.accent = preferences.value.accent
	}
	async function initialize() {
		apply()
		const result = await preferencesApi.setInterfaceScale(preferences.value.scale)
		if (!result.ok) throw new Error(result.error.message)
	}
	async function save(value: DesktopPreferences) {
		const parsed = desktopPreferencesSchema.parse(value)
		const result = await preferencesApi.setInterfaceScale(parsed.scale)
		if (!result.ok) throw new Error(result.error.message)
		try {
			localStorage.setItem(storageKey, JSON.stringify(parsed))
		} catch {
			await preferencesApi.setInterfaceScale(preferences.value.scale)
			throw new Error('Appearance could not be saved.')
		}
		preferences.value = parsed
		apply()
	}
	return { preferences, initialize, save }
})
