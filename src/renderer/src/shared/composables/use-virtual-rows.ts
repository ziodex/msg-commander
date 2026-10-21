import { computed, ref, watch, type Ref } from 'vue'
import { useElementSize } from '@vueuse/core'
export function useVirtualRows<T extends { key: string; height: number }>(
	rows: Ref<T[]>,
	root: Ref<HTMLElement | undefined>,
) {
	const scrollTop = ref(0)
	const { height } = useElementSize(root)
	const offsets = computed(() => {
		const values = [0]
		for (const row of rows.value) values.push(values.at(-1)! + row.height)
		return values
	})
	function indexAt(offset: number) {
		let low = 0,
			high = rows.value.length
		while (low < high) {
			const mid = (low + high) >>> 1
			if (offsets.value[mid + 1]! <= offset) low = mid + 1
			else high = mid
		}
		return low
	}
	const start = computed(() => Math.max(0, indexAt(scrollTop.value) - 6))
	const end = computed(() =>
		Math.min(rows.value.length, indexAt(scrollTop.value + (height.value || 400)) + 7),
	)
	const visible = computed(() =>
		rows.value
			.slice(start.value, end.value)
			.map((row, index) => ({ row, index: start.value + index })),
	)
	const before = computed(() => offsets.value[start.value] ?? 0)
	const after = computed(() => offsets.value.at(-1)! - (offsets.value[end.value] ?? 0))
	function onScroll() {
		scrollTop.value = root.value?.scrollTop ?? 0
	}
	function scrollTo(index: number) {
		if (!root.value) return
		const top = offsets.value[index] ?? 0,
			bottom = offsets.value[index + 1] ?? top
		if (top < root.value.scrollTop) root.value.scrollTop = top
		else if (bottom > root.value.scrollTop + root.value.clientHeight)
			root.value.scrollTop = bottom - root.value.clientHeight
		onScroll()
	}
	watch(
		() => rows.value.length,
		() => {
			const maximum = Math.max(0, offsets.value.at(-1)! - (height.value || 400))
			if (root.value && root.value.scrollTop > maximum) root.value.scrollTop = maximum
			onScroll()
		},
	)
	return { visible, before, after, onScroll, scrollTo }
}
