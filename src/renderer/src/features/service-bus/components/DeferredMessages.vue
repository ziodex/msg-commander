<script setup lang="ts">
import { serviceBusApi } from '@/features/service-bus/api'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { useListeners } from '@/features/service-bus/stores/listeners'
import { deferredReferencesRequestSchema, type DeferredReferences } from '@shared/deferred-messages'
const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ select: [sequence: string] }>()
const sb = useServiceBus(),
	workspace = useWorkspace(),
	listener = useListeners()
const references = ref<DeferredReferences>({ total: 0, items: [] })
const selected = ref(''),
	opened = ref(false),
	busy = ref(false),
	error = ref(''),
	notice = ref('')
let generation = 0
const scope = computed(() => ({
	connectionId: sb.connection?.connectionId,
	target: sb.selected?.target,
	subQueue: sb.subQueue,
	sessionId: sb.subQueue === 'active' ? props.sessionId : '',
}))
const scopeKey = computed(() =>
	JSON.stringify([
		sb.connection?.connectionId,
		sb.selected?.target,
		sb.subQueue,
		props.sessionId,
	]),
)
async function refresh() {
	const ticket = ++generation
	const parsed = deferredReferencesRequestSchema.safeParse({
		...scope.value,
		id: crypto.randomUUID(),
	})
	if (!parsed.success) {
		references.value = { total: 0, items: [] }
		busy.value = false
		return
	}
	busy.value = true
	error.value = ''
	try {
		const value = workspace.unwrapResult(
			await serviceBusApi.listDeferredReferences(parsed.data),
		)
		if (ticket !== generation) return
		references.value = value
		if (value.total) opened.value = true
		if (!value.items.some((item) => item.sequenceNumber === selected.value))
			selected.value = value.items[0]?.sequenceNumber ?? ''
	} catch (cause) {
		if (ticket === generation)
			error.value =
				cause instanceof Error ? cause.message : 'Deferred references could not be read.'
	} finally {
		if (ticket === generation) busy.value = false
	}
}
async function forget() {
	const parsed = deferredReferencesRequestSchema.safeParse({
		...scope.value,
		id: crypto.randomUUID(),
	})
	if (!parsed.success || !selected.value || busy.value) return
	const ticket = ++generation,
		sequence = selected.value
	busy.value = true
	error.value = notice.value = ''
	try {
		workspace.unwrapResult(
			await serviceBusApi.forgetDeferredReference({
				...parsed.data,
				sequenceNumber: sequence,
			}),
		)
		if (ticket !== generation) return
		notice.value = 'Reference forgotten. The message is unchanged.'
		await refresh()
	} catch (cause) {
		if (ticket === generation)
			error.value =
				cause instanceof Error ? cause.message : 'Reference could not be forgotten.'
	} finally {
		if (ticket === generation) busy.value = false
	}
}
watch(
	[scopeKey, () => sb.outcome, () => sb.held, () => listener.state?.deferred],
	(value, previous, cleanup) => {
		generation++
		if (value[0] !== previous?.[0]) {
			references.value = { total: 0, items: [] }
			opened.value = false
			selected.value = error.value = notice.value = ''
		}
		const timer = setTimeout(() => void refresh(), 150)
		cleanup(() => clearTimeout(timer))
	},
	{ immediate: true },
)
onBeforeUnmount(() => generation++)
</script>
<template>
	<details
		class="deferred-references"
		:open="opened"
		@toggle="opened = ($event.target as HTMLDetailsElement).open"
	>
		<summary>Deferred references · {{ references.total }}</summary>
		<div class="explorer-actions">
			<select
				v-model="selected"
				aria-label="Recorded deferred sequence"
				:disabled="busy || !references.items.length"
			>
				<option v-if="!references.items.length" value="">No recorded sequences</option>
				<option
					v-for="item in references.items"
					:key="item.sequenceNumber"
					:value="item.sequenceNumber"
				>
					{{ item.sequenceNumber }}
				</option>
			</select>
			<Button
				variant="outline"
				size="sm"
				:disabled="busy || !!sb.busy || !selected"
				@click="emit('select', selected)"
				>Use sequence</Button
			>
			<Button variant="outline" size="sm" :disabled="busy || !selected" @click="forget"
				>Forget reference</Button
			>
			<Button variant="ghost" size="sm" :disabled="busy" @click="refresh"
				>Refresh references</Button
			>
		</div>
		<p class="explorer-note">
			Local to this app session. Receiving locks the message; forgetting only removes its
			reference.
		</p>
		<p v-if="references.total > references.items.length" class="explorer-note">
			Showing {{ references.items.length }} of {{ references.total }}. Retrieve or forget
			these to show more.
		</p>
		<p v-if="notice" role="status" class="explorer-note">{{ notice }}</p>
		<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
	</details>
</template>
