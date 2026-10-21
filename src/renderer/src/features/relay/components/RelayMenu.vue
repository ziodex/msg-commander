<script setup lang="ts">
import { ref, nextTick } from 'vue'
import {
	ContextMenuRoot,
	ContextMenuTrigger,
	ContextMenuPortal,
	ContextMenuContent,
	ContextMenuLabel,
	ContextMenuItem,
} from 'reka-ui'
import { useRelay } from '@/features/relay/stores/relay'
import type { RelayScope } from '@shared/contracts/relay/core'
const props = defineProps<{ scope: RelayScope }>()
const emit = defineEmits<{
	action: [
		action:
			| 'refresh'
			| 'create-hybrid'
			| 'create-wcf'
			| 'edit'
			| 'delete'
			| 'policies'
			| 'copy'
			| 'test'
			| 'configuration',
		scope: RelayScope,
	]
}>()
const relay = useRelay(),
	open = ref(false)
let focusTarget: HTMLElement | undefined,
	handoff = false
function remember(event: Event) {
	focusTarget = event.target as HTMLElement
	handoff = false
}
function keyboard(event: KeyboardEvent) {
	if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
		event.preventDefault()
		event.stopPropagation()
		remember(event)
		open.value = true
	}
}
async function run(action: Parameters<typeof emit>[1]) {
	if (relay.busy) return
	handoff = true
	open.value = false
	focusTarget?.focus()
	await nextTick()
	emit('action', action, { ...props.scope })
}
function restore(event: Event) {
	event.preventDefault()
	if (!handoff) focusTarget?.focus()
}
</script>
<template>
	<ContextMenuRoot v-model:open="open"
		><ContextMenuTrigger as-child @contextmenu="remember" @keydown="keyboard"
			><slot /></ContextMenuTrigger
		><ContextMenuPortal
			><ContextMenuContent
				class="entity-context-menu"
				:collision-padding="8"
				@close-auto-focus="restore"
			>
				<ContextMenuLabel class="entity-context-label">{{
					scope.name || 'Relay namespace'
				}}</ContextMenuLabel>
				<ContextMenuItem :disabled="!!relay.busy" @select="run('refresh')"
					>Refresh status</ContextMenuItem
				>
				<template v-if="scope.kind === 'namespace'">
					<ContextMenuItem :disabled="relay.blocked" @select="run('create-hybrid')"
						>Create Hybrid Connection…</ContextMenuItem
					>
					<ContextMenuItem :disabled="relay.blocked" @select="run('create-wcf')"
						>Create WCF Relay…</ContextMenuItem
					>
				</template>
				<template v-else>
					<ContextMenuItem v-if="scope.kind === 'hybrid'" @select="run('test')"
						>Test Hybrid Connection…</ContextMenuItem
					>
					<ContextMenuItem :disabled="relay.blocked" @select="run('edit')"
						>Edit resource…</ContextMenuItem
					>
					<ContextMenuItem :disabled="!!relay.busy" @select="run('copy')"
						>Copy endpoint</ContextMenuItem
					>
				</template>
				<ContextMenuItem :disabled="!!relay.busy" @select="run('configuration')"
					>Export/import configuration…</ContextMenuItem
				>
				<ContextMenuItem :disabled="!!relay.busy" @select="run('policies')"
					>SAS policies and keys…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind !== 'namespace'"
					class="destructive"
					:disabled="relay.blocked"
					@select="run('delete')"
					>Delete resource…</ContextMenuItem
				>
			</ContextMenuContent></ContextMenuPortal
		></ContextMenuRoot
	>
</template>
