import { computed, ref, watch, type Ref } from 'vue'

export const bodyFormats = ['text', 'json', 'hex'] as const
type BodyFormat = (typeof bodyFormats)[number]

export function useBodyFormat(identity: () => string | null | undefined, json: Ref<string | null>) {
	const preferred = ref<BodyFormat | 'auto'>('auto')
	watch(
		identity,
		() => {
			preferred.value = 'auto'
		},
		{ flush: 'sync' },
	)
	const format = computed(() => {
		if (preferred.value === 'auto') return json.value === null ? 'text' : 'json'
		return preferred.value === 'json' && json.value === null ? 'text' : preferred.value
	})
	function selectFormat(value: BodyFormat) {
		preferred.value = value
	}
	return { format, selectFormat }
}
