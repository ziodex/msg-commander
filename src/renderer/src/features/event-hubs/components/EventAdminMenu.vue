<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { EventHubUrlTarget } from '@shared/contracts/event-hubs/core'
import {
	ContextMenuRoot,
	ContextMenuTrigger,
	ContextMenuPortal,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
} from 'reka-ui'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventHubsAdmin } from '@/features/event-hubs/stores/event-hubs-admin'
const props = defineProps<{
	kind: 'namespace' | 'hub' | 'group' | 'partition'
	partitionId?: string
	hubName?: string
	name?: string
}>()
const emit = defineEmits<{
	action: [
		action:
			| 'listen'
			| 'statistics'
			| 'create-hub'
			| 'edit-hub'
			| 'delete-hub'
			| 'create-group'
			| 'edit-group'
			| 'delete-group'
			| 'policies',
		hubName: string,
		name: string,
	]
}>()
const eh = useEventHubs(),
	admin = useEventHubsAdmin(),
	open = ref(false)
let focusTarget: HTMLElement | undefined,
	handingOff = false
function remember(event: Event) {
	focusTarget = event.target as HTMLElement
	handingOff = false
}
function keyboard(event: KeyboardEvent) {
	if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
		event.preventDefault()
		event.stopPropagation()
		remember(event)
		open.value = true
	}
}
async function run(
	action:
		| 'listen'
		| 'statistics'
		| 'create-hub'
		| 'edit-hub'
		| 'delete-hub'
		| 'create-group'
		| 'edit-group'
		| 'delete-group'
		| 'policies',
) {
	if (
		eh.busy ||
		(action !== 'listen' && action !== 'statistics' && !eh.connection?.managementAvailable)
	)
		return
	const hub = props.hubName ?? '',
		name = props.name ?? ''
	handingOff = true
	open.value = false
	focusTarget?.focus()
	await nextTick()
	emit('action', action, hub, name)
}
const urlTarget = computed((): EventHubUrlTarget =>
	props.kind === 'namespace'
		? { kind: 'namespace' }
		: props.kind === 'hub'
			? { kind: 'hub', hubName: props.hubName ?? '' }
			: props.kind === 'group'
				? { kind: 'group', hubName: props.hubName ?? '', consumerGroup: props.name ?? '' }
				: {
						kind: 'partition',
						hubName: props.hubName ?? '',
						consumerGroup: props.name ?? '',
						partitionId: props.partitionId ?? '',
					},
)
async function copy(scheme: 'https' | 'sb') {
	if (eh.busy) return
	handingOff = true
	open.value = false
	focusTarget?.focus()
	await nextTick()
	await eh.copyUrl(urlTarget.value, scheme)
}
function restore(event: Event) {
	event.preventDefault()
	if (!handingOff) focusTarget?.focus()
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
				><ContextMenuLabel class="entity-context-label">{{
					kind === 'namespace'
						? 'Event Hubs namespace'
						: kind === 'hub'
							? hubName
							: hubName + '/' + name
				}}</ContextMenuLabel>
				<ContextMenuItem
					v-if="kind === 'hub' || kind === 'group'"
					:disabled="!!eh.busy || eh.connection?.access === 'send'"
					@select="run('listen')"
					>Listen to all partitions…</ContextMenuItem
				>
				<ContextMenuItem
					v-if="kind !== 'namespace'"
					:disabled="!!eh.busy"
					@select="run('statistics')"
					>Statistics…</ContextMenuItem
				>
				<ContextMenuItem :disabled="!!eh.busy" @select="copy('https')"
					>Copy HTTPS URL</ContextMenuItem
				>
				<ContextMenuItem :disabled="!!eh.busy" @select="copy('sb')"
					>Copy Service Bus URL</ContextMenuItem
				>
				<template v-if="eh.connection?.service !== 'iot-hub' && kind !== 'partition'">
					<ContextMenuItem
						v-if="kind === 'namespace'"
						:disabled="admin.blocked || !eh.connection?.managementAvailable"
						@select="run('create-hub')"
						>Create Event Hub…</ContextMenuItem
					>
					<template v-if="kind === 'hub'"
						><ContextMenuItem
							:disabled="!!eh.busy || !eh.connection?.managementAvailable"
							@select="run('edit-hub')"
							>Edit Event Hub…</ContextMenuItem
						><ContextMenuItem
							:disabled="admin.blocked || !eh.connection?.managementAvailable"
							@select="run('create-group')"
							>Create consumer group…</ContextMenuItem
						></template
					>
					<ContextMenuItem
						v-if="kind === 'group'"
						:disabled="!!eh.busy || !eh.connection?.managementAvailable"
						@select="run('edit-group')"
						>Edit consumer group…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="kind !== 'group'"
						:disabled="!!eh.busy || !eh.connection?.managementAvailable"
						@select="run('policies')"
						>SAS policies and keys…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="kind === 'hub'"
						class="destructive"
						:disabled="admin.blocked || !eh.connection?.managementAvailable"
						@select="run('delete-hub')"
						>Delete Event Hub…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="kind === 'group'"
						class="destructive"
						:disabled="
							admin.blocked ||
							!eh.connection?.managementAvailable ||
							name === '$Default'
						"
						@select="run('delete-group')"
						>Delete consumer group…</ContextMenuItem
					>
				</template>
			</ContextMenuContent></ContextMenuPortal
		></ContextMenuRoot
	>
</template>
