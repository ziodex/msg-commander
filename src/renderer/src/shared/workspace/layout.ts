import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

export const useWorkspaceLayout = defineStore('workspace-layout', () => {
	function savedTreeVisibility() {
		try {
			return localStorage.getItem('commander-tree-visible') !== 'false'
		} catch {
			return true
		}
	}
	const treeVisible = ref(savedTreeVisibility())
	const resetVersion = ref(0)
	function reset() {
		try {
			for (const key of Object.keys(localStorage))
				if (
					key.startsWith('reka:commander-') ||
					/^commander-message-column-widths-v[12]$/.test(key)
				)
					localStorage.removeItem(key)
		} catch {
			// Apply defaults even when optional storage is unavailable.
		}
		treeVisible.value = true
		namespaceCountersVisible.value = false
		resetVersion.value++
	}
	const namespaceCountersVisible = ref(false)
	try {
		namespaceCountersVisible.value =
			localStorage.getItem('commander-namespace-counters-visible') === 'true'
	} catch {
		// Optional layout preference.
	}
	watch(namespaceCountersVisible, (value) => {
		try {
			localStorage.setItem('commander-namespace-counters-visible', String(value))
		} catch {
			// Optional layout preference.
		}
	})
	watch(treeVisible, (value) => {
		try {
			localStorage.setItem('commander-tree-visible', String(value))
		} catch {
			// Optional layout preference.
		}
	})
	return { treeVisible, namespaceCountersVisible, resetVersion, reset }
})
