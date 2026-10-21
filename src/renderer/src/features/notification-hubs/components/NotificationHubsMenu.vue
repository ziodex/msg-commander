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
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import type { NotificationHubScope } from '@shared/contracts/notification-hubs/core'
const props = defineProps<{ scope: NotificationHubScope }>()
const emit = defineEmits<{
	action: [
		action:
			| 'refresh'
			| 'create'
			| 'edit'
			| 'delete'
			| 'policies'
			| 'registrations'
			| 'notifications'
			| 'credentials'
			| 'configuration',
		scope: NotificationHubScope,
	]
}>()
const nh = useNotificationHubs(),
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
	if (nh.busy) return
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
					scope.name || 'Notification Hubs namespace'
				}}</ContextMenuLabel>
				<ContextMenuItem :disabled="!!nh.busy" @select="run('refresh')"
					>Refresh status</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind === 'namespace'"
					:disabled="nh.blocked"
					@select="run('create')"
					>Create Notification Hub…</ContextMenuItem
				>
				<ContextMenuItem v-else :disabled="nh.blocked" @select="run('edit')"
					>Edit hub…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind === 'hub'"
					:disabled="!!nh.busy"
					@select="run('registrations')"
					>Browse registrations…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind === 'hub'"
					:disabled="!!nh.busy"
					@select="run('notifications')"
					>Test notifications…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind === 'hub'"
					:disabled="nh.blocked"
					@select="run('credentials')"
					>Provider credentials…</ContextMenuItem
				>
				<ContextMenuItem :disabled="!!nh.busy" @select="run('configuration')"
					>Configuration files…</ContextMenuItem
				>
				<ContextMenuItem :disabled="!!nh.busy" @select="run('policies')"
					>SAS policies and keys…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="scope.kind !== 'namespace'"
					class="destructive"
					:disabled="nh.blocked"
					@select="run('delete')"
					>Delete hub…</ContextMenuItem
				>
			</ContextMenuContent></ContextMenuPortal
		></ContextMenuRoot
	>
</template>
