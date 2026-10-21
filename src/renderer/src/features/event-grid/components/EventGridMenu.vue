<script setup lang="ts">
import { ref } from 'vue'
import { ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal, ContextMenuContent } from 'reka-ui'
const props = defineProps<{ disabled: boolean }>()
const open = ref(false)
let focus: HTMLElement | undefined
function remember(event: Event) {
	focus = event.target as HTMLElement
}
function keyboard(event: KeyboardEvent) {
	if (
		!props.disabled &&
		(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
	) {
		event.preventDefault()
		event.stopPropagation()
		remember(event)
		open.value = true
	}
}
function restore(event: Event) {
	event.preventDefault()
	// Do not steal focus from a dialog opened by a menu action.
	if (!document.querySelector('[role="dialog"]')) focus?.focus()
}
</script>
<template>
	<ContextMenuRoot v-model:open="open"
		><ContextMenuTrigger
			as-child
			:disabled="disabled"
			@contextmenu="remember"
			@keydown="keyboard"
			><slot name="trigger" /></ContextMenuTrigger
		><ContextMenuPortal
			><ContextMenuContent
				class="entity-context-menu"
				:collision-padding="8"
				@close-auto-focus="restore"
				><slot /></ContextMenuContent></ContextMenuPortal
	></ContextMenuRoot>
</template>
