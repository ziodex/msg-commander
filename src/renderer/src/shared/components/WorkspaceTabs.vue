<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
const props = withDefaults(
	defineProps<{
		items: { id: string; label: string }[]
		active: string
		disabled?: boolean
		label: string
		closeLabel?: string
		controls?: string
	}>(),
	{ closeLabel: 'Close entity tab', controls: 'entity-tab-content' },
)
const emit = defineEmits<{ select: [id: string]; close: [id: string] }>()
const root = ref<HTMLElement>()
const scrollPositions = new Map<string, number>()
async function choose(index: number, focus = false) {
	const tab = props.items[index]
	if (!tab || props.disabled) return
	emit('select', tab.id)
	if (focus) {
		await nextTick()
		root.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
	}
}
function keys(event: KeyboardEvent, index: number) {
	const count = props.items.length
	if (event.key === 'ArrowRight') void choose((index + 1) % count, true)
	else if (event.key === 'ArrowLeft') void choose((index + count - 1) % count, true)
	else if (event.key === 'Home') void choose(0, true)
	else if (event.key === 'End') void choose(count - 1, true)
	else if (event.key === 'Delete') emit('close', props.items[index]!.id)
	else return
	event.preventDefault()
}
function shortcut(event: KeyboardEvent) {
	if (
		!(event.ctrlKey || event.metaKey) ||
		props.disabled ||
		!props.items.length ||
		document.querySelector('[role="dialog"]')
	)
		return
	const index = Math.max(
		0,
		props.items.findIndex((tab) => tab.id === props.active),
	)
	if (event.key === 'PageDown') void choose((index + 1) % props.items.length, true)
	else if (event.key === 'PageUp')
		void choose((index + props.items.length - 1) % props.items.length, true)
	else if (event.key === 'F4' && props.active) emit('close', props.active)
	else return
	event.preventDefault()
}
watch(
	() => props.active,
	async (id, previous) => {
		const panel = document.getElementById(props.controls)
		if (panel && previous && props.items.some((tab) => tab.id === previous))
			scrollPositions.set(previous, panel.scrollTop)
		for (const key of scrollPositions.keys())
			if (!props.items.some((tab) => tab.id === key)) scrollPositions.delete(key)
		await nextTick()
		if (panel) panel.scrollTop = scrollPositions.get(id) ?? 0
		const tab = root.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
		if (tab && root.value) {
			const bounds = tab.getBoundingClientRect(),
				viewport = root.value.getBoundingClientRect()
			if (bounds.left < viewport.left) root.value.scrollLeft += bounds.left - viewport.left
			else if (bounds.right > viewport.right)
				root.value.scrollLeft += bounds.right - viewport.right
		}
	},
)
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
</script>
<template>
	<div v-if="items.length" ref="root" class="entity-tabs">
		<div class="entity-tab-list" role="tablist" :aria-label="label">
			<button
				v-for="(tab, index) in items"
				:key="tab.id"
				class="entity-tab-label"
				:class="{ active: active === tab.id }"
				:style="{ order: index * 2 }"
				role="tab"
				:aria-selected="active === tab.id"
				:aria-controls="controls"
				:tabindex="active === tab.id || (!active && index === 0) ? 0 : -1"
				:disabled="disabled"
				:title="tab.label + ' · Ctrl+PageUp / PageDown'"
				@click="choose(index)"
				@keydown="keys($event, index)"
			>
				{{ tab.label }}
			</button>
		</div>
		<div
			class="entity-tab-close-list"
			role="group"
			:aria-label="'Close ' + label.toLowerCase()"
		>
			<button
				v-for="(tab, index) in items"
				:key="tab.id"
				class="entity-tab-close"
				:class="{ active: active === tab.id }"
				:style="{ order: index * 2 + 1 }"
				:disabled="disabled"
				:aria-label="closeLabel + ' ' + tab.label"
				title="Close tab · Ctrl+F4"
				@click="emit('close', tab.id)"
			>
				<X :size="13" />
			</button>
		</div>
	</div>
</template>
