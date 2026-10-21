import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useWorkspace } from '@/shared/workspace/store'

export function useDesktopAppearance() {
	const store = useWorkspace()
	const media = window.matchMedia('(prefers-color-scheme: dark)')
	const systemDark = ref(media.matches)
	const dark = computed(
		() => store.theme === 'dark' || (store.theme === 'system' && systemDark.value),
	)
	const onMedia = (event: MediaQueryListEvent) => {
		systemDark.value = event.matches
	}
	watch(dark, (value) => document.documentElement.classList.toggle('dark', value), {
		immediate: true,
	})

	media.addEventListener('change', onMedia)
	onBeforeUnmount(() => media.removeEventListener('change', onMedia))
	return { dark }
}
