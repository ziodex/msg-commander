<script setup lang="ts">
import { notificationHubsApi } from '@/features/notification-hubs/api'

import { computed, ref, watch } from 'vue'
import NotificationComposer from './NotificationComposer.vue'
import NotificationSendInspector from './NotificationSendInspector.vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useNotificationSender } from '@/features/notification-hubs/stores/notification-hub-notifications'
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import { useWorkspace } from '@/shared/workspace/store'
import type { Profile } from '@shared/contracts'
import type {
	NotificationHubPage,
	NotificationHubTarget,
} from '@shared/contracts/notification-hubs/core'
import { nhRegistrationsConnectSchema } from '@shared/contracts/notification-hubs/registrations'
const props = defineProps<{ profile: Profile; initialHub: string }>(),
	emit = defineEmits<{ back: [] }>()
const sender = useNotificationSender(),
	nh = useNotificationHubs(),
	workspace = useWorkspace()
const hubName = ref(props.initialHub || sender.connection?.hubName || ''),
	source = ref<'profile' | 'policy'>(props.profile.auth === 'sas' ? 'profile' : 'policy')
const policyScope = ref<'hub' | 'namespace'>('namespace'),
	policies = ref<NotificationHubPage>({ items: [], continuationToken: null }),
	selectedPolicy = ref(''),
	keyType = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey')
const formError = ref('')
const connected = computed(
	() =>
		sender.connection?.profileId === props.profile.id &&
		sender.connection.hubName === hubName.value,
)
const management = computed(() =>
	nh.connection?.profileId === props.profile.id ? nh.connection : undefined,
)
const pending = computed(() => !!sender.busy || !!nh.busy)
const policyTarget = (): NotificationHubTarget | null =>
	selectedPolicy.value
		? {
				scope:
					policyScope.value === 'namespace'
						? { kind: 'namespace', name: '' }
						: { kind: 'hub', name: hubName.value },
				policyName: selectedPolicy.value,
			}
		: null
let epoch = 0
watch([hubName, policyScope, source, () => nh.connection?.connectionId], () => {
	epoch++
	policies.value = { items: [], continuationToken: null }
	selectedPolicy.value = ''
	formError.value = ''
})
watch(
	() => sender.connection?.connectionId,
	() => {
		formError.value = ''
	},
)
async function loadPolicies(more = false) {
	if (!management.value || pending.value || (policyScope.value === 'hub' && !hubName.value))
		return
	const ticket = epoch
	const scope =
		policyScope.value === 'namespace'
			? { kind: 'namespace' as const, name: '' as const }
			: { kind: 'hub' as const, name: hubName.value }
	await sender.task(
		'List notification send policies',
		(id) =>
			notificationHubsApi.listNotificationHub({
				id,
				connectionId: management.value!.connectionId,
				scope,
				kind: 'policies',
				continuationToken: more ? policies.value.continuationToken : null,
			}),
		(value) => {
			if (ticket !== epoch) return
			policies.value = {
				items: more
					? [
							...policies.value.items,
							...value.items.filter(
								(i) =>
									!policies.value.items.some(
										(old) => old.target.policyName === i.target.policyName,
									),
							),
						]
					: value.items,
				continuationToken: value.continuationToken,
			}
		},
	)
}
async function connect() {
	const setup = {
		profileId: props.profile.id,
		hubName: hubName.value,
		source: source.value,
		managementConnectionId:
			source.value === 'policy' ? (management.value?.connectionId ?? null) : null,
		policyTarget: source.value === 'policy' ? policyTarget() : null,
		keyType: source.value === 'policy' ? keyType.value : null,
	}
	const parsed = nhRegistrationsConnectSchema.safeParse({ ...setup, id: crypto.randomUUID() })
	if (!parsed.success) {
		formError.value =
			'Enter a hub name and select a Send or Manage policy from this hub or its namespace, or use the saved SAS profile.'
		return
	}
	formError.value = ''
	await sender.connect(setup)
}
function back() {
	sender.composer = sender.inspection = false
	emit('back')
}
</script>
<template>
	<section class="nh-notifications" aria-label="Notification Hubs test sends">
		<div class="nh-heading">
			<div>
				<div class="eyebrow">Notification Hubs</div>
				<h2>Test notifications</h2>
				<p class="field-hint">
					Send a real test notification to up to 10 matching devices and inspect
					push-provider outcomes.
				</p>
			</div>
			<Button variant="outline" size="sm" :disabled="pending" @click="back"
				>Back to administration</Button
			>
		</div>
		<form v-if="!connected" class="nh-notification-setup nh-form" @submit.prevent="connect">
			<label
				>Notification sender hub name<Input
					v-model="hubName"
					:disabled="pending"
					placeholder="my-hub"
			/></label>
			<label
				>Notification sender credential<select
					aria-label="Notification sender credential"
					v-model="source"
					:disabled="pending"
				>
					<option v-if="profile.auth === 'sas'" value="profile">Saved SAS profile</option>
					<option value="policy">Select a Send or Manage policy through Entra</option>
				</select></label
			>
			<p v-if="source === 'profile'" class="field-hint">
				Connect uses the saved SAS key for this hub. A hub-scoped connection string must
				match the hub name. Sending requires Send or Manage rights.
			</p>
			<template v-else>
				<p v-if="!management" class="form-warning">
					Connect Notification Hubs management first, then select a Send or Manage policy
					explicitly.
				</p>
				<template v-else
					><div class="nh-fields">
						<label
							>Policy scope<select
								aria-label="Notification sender policy scope"
								v-model="policyScope"
								:disabled="pending"
							>
								<option value="namespace">Namespace</option>
								<option value="hub">This hub</option>
							</select></label
						><Button
							type="button"
							variant="outline"
							:disabled="pending || !hubName"
							@click="loadPolicies()"
							>Load access policies</Button
						>
					</div>
					<div class="nh-fields">
						<label
							>Send or Manage policy<select
								aria-label="Notification sender Send or Manage policy"
								v-model="selectedPolicy"
								:disabled="pending"
							>
								<option value="" disabled>Select a policy</option>
								<option
									v-for="item in policies.items"
									:key="item.target.policyName!"
									:value="item.target.policyName!"
									:disabled="
										!item.rights?.includes('Manage') &&
										!item.rights?.includes('Send')
									"
								>
									{{ item.target.policyName }} · {{ item.rights?.join(', ') }}
								</option>
							</select></label
						><label
							>Notification sender key slot<select
								aria-label="Notification sender key slot"
								v-model="keyType"
								:disabled="pending"
							>
								<option value="PrimaryKey">Primary key</option>
								<option value="SecondaryKey">Secondary key</option>
							</select></label
						>
					</div>
					<Button
						v-if="policies.continuationToken"
						type="button"
						variant="ghost"
						:disabled="pending"
						@click="loadPolicies(true)"
						>Load more access policies</Button
					>
					<p class="field-hint">
						Connect fetches only the selected key using your Entra listKeys permission.
						It stays in the backend for this connection.
					</p></template
				>
			</template>
			<Button
				type="submit"
				:disabled="pending || !workspace.ready || (source === 'policy' && !management)"
				>Connect notification sender</Button
			>
		</form>
		<template v-else>
			<div class="nh-toolbar">
				<span class="nh-connected"
					><span class="status-dot ready" />Notification sender connected ·
					{{ sender.connection?.hubName }}</span
				><span class="field-hint">{{ profile.namespace }} · SAS Send access</span
				><Button variant="ghost" size="sm" :disabled="pending" @click="sender.disconnect()"
					>Disconnect notification sender</Button
				>
			</div>
			<div class="nh-actions">
				<Button :disabled="sender.blocked" @click="sender.composer = true"
					>Compose test notification…</Button
				><Button v-if="sender.outcome" variant="outline" @click="sender.inspection = true"
					>Inspect send result…</Button
				>
			</div>
			<p class="field-hint">
				Test mode is throttled and delivers real notifications. A confirmed send is Azure's
				acknowledgment; per-device results describe push-provider outcomes, not application
				delivery.
			</p>
			<div v-if="sender.outcome" class="nh-receipt" role="status">
				<strong>Last test send · {{ sender.outcome.status }}</strong>
				<p>{{ sender.outcome.summary }}</p>
				<small>Receipt: {{ sender.outcome.operationId }}</small
				><template v-if="sender.outcome.status === 'unknown'"
					><Button
						variant="outline"
						size="sm"
						:disabled="pending"
						@click="sender.recover()"
						>Check test send receipt</Button
					><label class="checkbox-label"
						><input v-model="sender.reviewed" type="checkbox" :disabled="pending" />I
						reviewed the uncertain outcome and device/provider state before another
						send.</label
					></template
				>
			</div>
		</template>
		<div v-if="sender.busy" class="nh-working" role="status">
			{{ sender.busy }}…<Button variant="outline" size="sm" @click="sender.cancel()"
				>Cancel notification operation</Button
			>
		</div>
		<p v-if="formError || sender.error" class="form-error" role="alert">
			{{ formError || sender.error }}
		</p>
		<NotificationComposer v-if="connected && sender.composer" />
		<NotificationSendInspector
			v-if="connected && sender.inspection && sender.outcome"
			:outcome="sender.outcome"
			@close="sender.inspection = false"
		/>
	</section>
</template>
<style>
.nh-notifications {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-width: 0;
}
.nh-notifications select {
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	padding: 8px;
	color: var(--foreground);
}
</style>
