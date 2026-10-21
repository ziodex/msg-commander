<script setup lang="ts">
import { relayApi } from '@/features/relay/api'

import { ref, watch, onBeforeUnmount } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useRelay } from '@/features/relay/stores/relay'
import { relayPath, type RelayTarget } from '@shared/contracts/relay/core'
import type { AuthorizationKey } from '@shared/authorization'
const props = defineProps<{ target: RelayTarget }>(),
	emit = defineEmits<{ close: [] }>()
const relay = useRelay(),
	slot = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey'),
	key = ref<AuthorizationKey>(),
	copied = ref('')
let epoch = 0,
	timer: ReturnType<typeof setTimeout> | undefined
function clear() {
	epoch++
	key.value = undefined
	copied.value = ''
	clearTimeout(timer)
}
watch([slot, () => props.target, () => relay.connection?.connectionId], clear)
onBeforeUnmount(clear)
const target = () => ({ scope: { ...props.target.scope }, policyName: props.target.policyName })
async function reveal() {
	clear()
	const ticket = epoch
	const value = await relay.run('Reveal selected Relay SAS key', (id, connectionId) =>
		relayApi.revealRelayKey({ id, connectionId, target: target(), keyType: slot.value }),
	)
	if (value && ticket === epoch) {
		key.value = value
		timer = setTimeout(clear, 30000)
	}
}
async function copy(format: 'key' | 'connectionString') {
	const ticket = epoch
	const value = await relay.run('Copy selected Relay credential', (id, connectionId) =>
		relayApi.copyRelayKey({
			id,
			connectionId,
			target: target(),
			keyType: slot.value,
			format,
		}),
	)
	if (value === null && ticket === epoch) copied.value = 'Copied to clipboard.'
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && emit('close')"
		><DialogContent class="sm:max-w-[680px] relay-dialog"
			><DialogHeader
				><DialogTitle>Relay SAS keys</DialogTitle
				><DialogDescription
					>{{ relayPath(props.target) }} ·
					{{ relay.connection?.namespace }}</DialogDescription
				></DialogHeader
			>
			<p class="field-hint">
				Keys are fetched only on request. Revealed values hide after 30 seconds or when this
				dialog closes. Copied credentials remain on the system clipboard.
			</p>
			<label
				>Key slot<select aria-label="Key slot" v-model="slot" :disabled="!!relay.busy">
					<option value="PrimaryKey">Primary key</option>
					<option value="SecondaryKey">Secondary key</option>
				</select></label
			>
			<div class="relay-actions">
				<Button :disabled="!!relay.busy" @click="reveal">Reveal key</Button
				><Button variant="outline" :disabled="!!relay.busy" @click="copy('key')"
					>Copy key</Button
				><Button
					variant="outline"
					:disabled="!!relay.busy"
					@click="copy('connectionString')"
					>Copy connection string</Button
				><Button v-if="key" variant="ghost" @click="clear">Hide keys</Button>
			</div>
			<template v-if="key"
				><label>Selected key<textarea readonly :value="key.key" rows="2" /></label
				><label
					>Connection string<textarea
						readonly
						:value="key.connectionString"
						rows="3"
					/></label
			></template>
			<p v-if="copied" role="status">{{ copied }}</p>
			<p v-if="relay.error" role="alert" class="form-error">{{ relay.error }}</p>
			<Button variant="outline" @click="emit('close')">Close keys</Button></DialogContent
		></Dialog
	>
</template>
