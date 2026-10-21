<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import {
	defaultRelaySettings,
	relayChangeSchema,
	relayPath,
	type RelayTarget,
	type RelayChange,
	type RelayDetails,
} from '@shared/contracts/relay/core'
import type { AuthorizationRight } from '@shared/authorization'
import { useRelay } from '@/features/relay/stores/relay'
const props = defineProps<{ target: RelayTarget; action: RelayChange['action'] }>()
const emit = defineEmits<{ close: [] }>()
const relay = useRelay(),
	name = ref(''),
	current = ref<RelayDetails>(),
	error = ref(''),
	ack = ref(false),
	done = ref(false)
const settings = ref(defaultRelaySettings('hybrid')),
	rights = ref<AuthorizationRight[]>(['Listen']),
	keyType = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey')
const policy = computed(() => props.target.policyName !== null)
const target = computed<RelayTarget>(() => ({
	scope: {
		...props.target.scope,
		name: props.action === 'create' && !policy.value ? name.value : props.target.scope.name,
	} as RelayTarget['scope'],
	policyName: props.action === 'create' && policy.value ? name.value : props.target.policyName,
}))
const title = computed(
	() =>
		`${props.action === 'create' ? 'Create' : props.action === 'update' ? 'Edit' : props.action === 'delete' ? 'Delete' : 'Regenerate key for'} ${policy.value ? 'SAS policy' : props.target.scope.kind === 'hybrid' ? 'Hybrid Connection' : 'WCF Relay'}`,
)
const editing = computed(() => props.action === 'create' || props.action === 'update')
const unsupported = computed(
	() => props.action === 'update' && !policy.value && !current.value?.settings,
)
watch(
	() => [props.target, props.action],
	async () => {
		ack.value = false
		done.value = false
		current.value = undefined
		error.value = ''
		name.value = ''
		settings.value = defaultRelaySettings(props.target.scope.kind === 'wcf' ? 'wcf' : 'hybrid')
		rights.value = ['Listen']
		keyType.value = 'PrimaryKey'
		if (props.action !== 'create') {
			const value = await relay.get(props.target)
			if (value) {
				current.value = value
				if (value.settings) settings.value = { ...value.settings }
				if (value.rights) rights.value = [...value.rights]
			}
		}
	},
	{ immediate: true },
)
watch(
	[settings, rights, name, keyType],
	() => {
		ack.value = false
	},
	{ deep: true },
)
function setRight(right: AuthorizationRight, checked: boolean) {
	const next = new Set(rights.value)
	if (checked) next.add(right)
	else next.delete(right)
	if (right === 'Manage' && checked) {
		next.add('Send')
		next.add('Listen')
	}
	if (right !== 'Manage' && !checked) next.delete('Manage')
	rights.value = [...next]
}
async function submit() {
	if (
		!ack.value ||
		relay.blocked ||
		(props.action !== 'create' && !current.value) ||
		unsupported.value
	)
		return
	const parsed = relayChangeSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: relay.connection?.connectionId,
		target: target.value,
		action: props.action,
		expectedRevision: current.value?.revision ?? null,
		settings: editing.value && !policy.value ? settings.value : null,
		rights: editing.value && policy.value ? rights.value : null,
		keyType: props.action === 'regenerate' ? keyType.value : null,
		acknowledged: true,
	})
	if (!parsed.success) {
		error.value = parsed.error.issues[0].message
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = parsed.data
	const result = await relay.change(setup)
	if (result) {
		done.value = true
		ack.value = false
		await relay.afterChange(result)
	}
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !relay.busy && emit('close')"
		><DialogContent
			class="sm:max-w-[620px] relay-dialog"
			@escape-key-down="relay.busy && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
			><DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription
					>{{ relay.connection?.namespace }} · {{ relayPath(target) }}</DialogDescription
				></DialogHeader
			>
			<template v-if="done"
				><p role="status">{{ relay.outcome?.summary }}</p>
				<p class="field-hint">Receipt: {{ relay.outcome?.operationId }}</p>
				<Button variant="outline" :disabled="!!relay.busy" @click="emit('close')"
					>Close Relay result</Button
				></template
			>
			<form v-else class="relay-form" @submit.prevent="submit">
				<fieldset :disabled="!!relay.busy">
					<label v-if="action === 'create'"
						>{{ policy ? 'Policy name' : 'Resource name'
						}}<Input v-model="name" :maxlength="policy ? 50 : 260" required
					/></label>
					<template v-if="editing && !policy">
						<label
							>Metadata<textarea
								v-model="settings.userMetadata"
								maxlength="1024"
								rows="3"
							/>
						</label>
						<label class="checkbox-label"
							><input
								v-model="settings.requiresClientAuthorization"
								type="checkbox"
							/>Require client authorization</label
						>
						<p v-if="!settings.requiresClientAuthorization" class="form-warning">
							Clients will be able to connect without a sender token. Review this
							before saving.
						</p>
						<template v-if="target.scope.kind === 'wcf'"
							><label
								>Relay type<select
									aria-label="Relay type"
									v-model="settings.relayType"
									:disabled="action === 'update'"
								>
									<option>Http</option>
									<option>NetTcp</option>
								</select></label
							><label class="checkbox-label"
								><input
									v-model="settings.requiresTransportSecurity"
									type="checkbox"
								/>Require transport security</label
							>
							<p class="field-hint">
								Resource management only. Legacy WCF binding tests are excluded from
								this application.
							</p></template
						>
					</template>
					<fieldset v-if="editing && policy">
						<legend>Policy rights</legend>
						<label
							v-for="right in ['Listen', 'Send', 'Manage'] as const"
							:key="right"
							class="checkbox-label"
							><input
								type="checkbox"
								:checked="rights.includes(right)"
								@change="
									setRight(right, ($event.target as HTMLInputElement).checked)
								"
							/>{{ right }}</label
						>
						<p class="field-hint">Manage includes Send and Listen.</p>
					</fieldset>
					<template v-if="action === 'regenerate'"
						><label
							>Key slot<select aria-label="Key slot" v-model="keyType">
								<option value="PrimaryKey">Primary key</option>
								<option value="SecondaryKey">Secondary key</option>
							</select></label
						>
						<p class="form-warning">
							Clients using this key will lose access. Switch them to the other key
							before rotation.
						</p></template
					>
					<p v-if="action === 'delete'" class="form-warning">
						Permanently delete {{ relayPath(target)
						}}{{ policy ? '' : ' and its SAS policies' }}. Connected clients may lose
						access.
					</p>
					<p v-if="current?.warning" class="form-warning">{{ current.warning }}</p>
					<p v-if="action !== 'create'" class="field-hint">
						The current settings are checked again before saving. Azure does not provide
						an atomic rename or a guaranteed conditional update here; coordinate
						concurrent administration.
					</p>
					<label class="checkbox-label"
						><input
							v-model="ack"
							type="checkbox"
							:disabled="unsupported || (action !== 'create' && !current)"
						/>I reviewed this {{ action }} action for {{ relayPath(target) }}.</label
					>
				</fieldset>
				<p v-if="error || relay.error" class="form-error" role="alert">
					{{ error || relay.error }}
				</p>
				<p v-if="relay.busy" role="status">{{ relay.busy }}…</p>
				<DialogFooter
					><Button
						v-if="relay.busy"
						type="button"
						variant="outline"
						@click="relay.cancel()"
						>Cancel operation</Button
					><Button v-else type="button" variant="outline" @click="emit('close')"
						>Cancel</Button
					><Button
						type="submit"
						:disabled="
							!ack ||
							relay.blocked ||
							unsupported ||
							(action !== 'create' && !current)
						"
						:variant="action === 'delete' ? 'destructive' : 'default'"
						>{{ title }}</Button
					></DialogFooter
				>
			</form>
		</DialogContent></Dialog
	>
</template>
