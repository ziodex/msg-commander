<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowRight, Command } from '@lucide/vue'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import type { WorkspaceCommand } from '../model/commands'
const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ commands: WorkspaceCommand[] }>()
const query = ref(''),
	index = ref(0)
const items = computed(() =>
	props.commands.filter((item) =>
		`${item.name} ${item.detail}`.toLowerCase().includes(query.value.toLowerCase()),
	),
)
watch(query, () => {
	index.value = 0
})
watch(open, () => {
	query.value = ''
	index.value = 0
})
function runCommand(command?: WorkspaceCommand) {
	command?.action()
	open.value = false
}
function shortcut(event: KeyboardEvent) {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
		event.preventDefault()
		open.value = !open.value
	}
}
onMounted(() => window.addEventListener('keydown', shortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', shortcut))
function paletteKey(event: KeyboardEvent) {
	if (event.isComposing) return
	if (event.key === 'Enter') {
		event.preventDefault()
		runCommand(items.value[index.value])
	} else if (
		['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
		!event.shiftKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		event.preventDefault()
		const last = items.value.length - 1
		index.value = Math.max(
			0,
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? last
					: Math.min(last, index.value + (event.key === 'ArrowDown' ? 1 : -1)),
		)
		void nextTick(() =>
			document
				.getElementById(`command-option-${index.value}`)
				?.scrollIntoView({ block: 'nearest' }),
		)
	}
}
</script>
<template>
	<Dialog v-model:open="open"
		><DialogContent class="command-dialog"
			><DialogHeader
				><DialogTitle>Command palette</DialogTitle
				><DialogDescription
					>Find a service, connection or workspace action.</DialogDescription
				></DialogHeader
			><Input
				v-model="query"
				placeholder="Search commands…"
				aria-label="Search commands"
				role="combobox"
				aria-autocomplete="list"
				aria-controls="command-options"
				:aria-expanded="true"
				:aria-activedescendant="items.length ? `command-option-${index}` : undefined"
				@keydown="paletteKey"
			/>
			<div id="command-options" class="command-results" role="listbox" aria-label="Commands">
				<button
					v-for="(item, itemIndex) in items"
					:key="item.name + item.detail"
					:id="`command-option-${itemIndex}`"
					role="option"
					:aria-selected="itemIndex === index"
					@focus="index = itemIndex"
					@click="runCommand(item)"
				>
					<Command :size="15" /><span
						>{{ item.name }}<small>{{ item.detail }}</small></span
					><ArrowRight :size="14" />
				</button>
				<p v-if="!items.length">No matching commands.</p>
			</div></DialogContent
		></Dialog
	>
</template>
