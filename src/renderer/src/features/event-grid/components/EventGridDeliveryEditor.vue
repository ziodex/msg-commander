<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import type {
	EventGridDelivery,
	EventGridDeliveryDetails,
	EventGridHeader,
	EventGridIdentity,
} from '@shared/contracts/event-grid/delivery'
const props = defineProps<{
	destinationType?: string | null
	mode: string
	creating: boolean
	disabled: boolean
	current?: EventGridDeliveryDetails | null
	replacing: boolean
}>()
const model = defineModel<EventGridDelivery>({ required: true })
const webhookTenant = ref(''),
	webhookAudience = ref('')
const headerMode = ref('keep'),
	identityMode = ref('keep'),
	userIdentity = ref(''),
	deadMode = ref('keep'),
	deadResource = ref(''),
	deadContainer = ref(''),
	deadIdentity = ref('SystemAssigned'),
	deadUser = ref(''),
	headers = ref<EventGridHeader[]>([])
const identity = (type: string, id: string): EventGridIdentity => ({
	type: type as EventGridIdentity['type'],
	userAssignedIdentity: type === 'UserAssigned' ? id.trim() : null,
})
function sync() {
	model.value = {
		identity:
			props.mode !== 'Push' || identityMode.value === 'keep'
				? null
				: identity(identityMode.value, userIdentity.value),
		headers: props.mode !== 'Push' || headerMode.value === 'keep' ? null : headers.value,
		webhookAuthentication:
			props.destinationType === 'WebHook' &&
			['SystemAssigned', 'UserAssigned'].includes(identityMode.value)
				? {
						tenantId: webhookTenant.value.trim(),
						applicationIdOrUri: webhookAudience.value.trim(),
					}
				: null,
		deadLetter:
			deadMode.value === 'keep'
				? null
				: deadMode.value === 'clear'
					? { action: 'clear', resourceId: null, containerName: null, identity: null }
					: {
							action: 'set',
							resourceId: deadResource.value.trim(),
							containerName: deadContainer.value.trim(),
							identity: identity(deadIdentity.value, deadUser.value),
						},
	}
}
watch(
	[
		webhookTenant,
		webhookAudience,
		() => props.destinationType,
		headerMode,
		identityMode,
		userIdentity,
		deadMode,
		deadResource,
		deadContainer,
		deadIdentity,
		deadUser,
		headers,
		() => props.mode,
	],
	sync,
	{ deep: true },
)
watch(
	() => props.replacing,
	(replacing) => {
		if (replacing) {
			headerMode.value = 'replace'
			headers.value = []
			identityMode.value = 'None'
			userIdentity.value = ''
		} else {
			headerMode.value = 'keep'
			headers.value = []
			identityMode.value = 'keep'
			userIdentity.value = ''
		}
		webhookTenant.value = ''
		webhookAudience.value = ''
		sync()
	},
)
const summary = computed(
	() =>
		props.current?.headers
			.map((h) => `${h.name} (${h.type}${h.isSecret ? ', secret' : ''})`)
			.join(', ') || 'None',
)
function addHeader() {
	headers.value.push({ name: '', type: 'Static', value: '', isSecret: true })
}
function headerType(index: number, type: string) {
	const name = headers.value[index].name
	headers.value[index] =
		type === 'Dynamic'
			? { name, type: 'Dynamic', sourceField: 'data.category' }
			: { name, type: 'Static', value: '', isSecret: true }
}
</script>
<template>
	<section class="eg-delivery-editor">
		<h3>Delivery configuration</h3>
		<p v-if="current && mode === 'Push'" class="field-hint">
			Current destination: {{ current.destinationType ?? 'Unsupported' }}<br />{{
				current.resourceId
			}}<br />Identity: {{ current.identity?.type ?? 'Unsupported' }}
			{{ current.identity?.userAssignedIdentity }}
		</p>
		<template v-if="mode === 'Push'">
			<label
				>Delivery identity<select
					v-model="identityMode"
					aria-label="Delivery identity"
					:disabled="disabled"
				>
					<option v-if="!replacing" value="keep">Keep existing identity</option>
					<option value="None">Event Grid default authentication</option>
					<option>SystemAssigned</option>
					<option>UserAssigned</option>
				</select></label
			>
			<label v-if="identityMode === 'UserAssigned'"
				>Delivery user-assigned identity ARM ID<Input
					v-model="userIdentity"
					:disabled="disabled"
			/></label>
			<template
				v-if="
					destinationType === 'WebHook' &&
					['SystemAssigned', 'UserAssigned'].includes(identityMode)
				"
			>
				<label
					>Webhook token tenant ID<Input
						v-model="webhookTenant"
						:disabled="disabled"
						autocomplete="off"
				/></label>
				<label
					>Webhook token audience (application ID or URI)<Input
						v-model="webhookAudience"
						:disabled="disabled"
						autocomplete="off"
				/></label>
			</template>
			<p class="field-hint">
				Managed identities must already be enabled on this namespace and have destination
				permissions (for Event Hubs: Azure Event Hubs Data Sender). This editor checks
				namespace membership; Azure checks RBAC. Managed webhook delivery also requires a
				token tenant and audience.
			</p>
			<p v-if="current" class="field-hint">
				Existing header names: {{ summary }}. Values stay private.
			</p>
			<label
				>Custom delivery headers<select
					v-model="headerMode"
					aria-label="Custom delivery headers"
					:disabled="disabled"
				>
					<option v-if="!replacing" value="keep">Keep existing headers</option>
					<option value="replace">Replace all headers</option>
				</select></label
			>
			<template v-if="headerMode === 'replace'">
				<p class="form-warning">
					This replaces all existing headers. An empty list removes them. Enter fresh
					values for every header you want to keep. Headers are supported here for WebHook
					and EventHub destinations.
				</p>
				<div v-for="(header, index) in headers" :key="index" class="eg-filter-edit">
					<div class="nh-fields">
						<label
							>Header name<Input
								v-model="header.name"
								:aria-label="`Delivery header ${index + 1} name`"
								:disabled="disabled"
						/></label>
						<label
							>Header type<select
								:value="header.type"
								:aria-label="`Delivery header ${index + 1} type`"
								:disabled="disabled"
								@change="
									headerType(index, ($event.target as HTMLSelectElement).value)
								"
							>
								<option>Static</option>
								<option>Dynamic</option>
							</select></label
						>
					</div>
					<template v-if="header.type === 'Static'">
						<label
							>Header value (write-only)<Input
								v-model="header.value"
								:aria-label="`Delivery header ${index + 1} value`"
								type="password"
								autocomplete="off"
								:disabled="disabled"
						/></label>
						<label class="eg-check"
							><input
								v-model="header.isSecret"
								type="checkbox"
								:aria-label="`Delivery header ${index + 1} secret`"
								:disabled="disabled"
							/>
							Mark as secret in Azure</label
						>
					</template>
					<label v-else
						>Event JSON path<Input
							v-model="header.sourceField"
							:aria-label="`Delivery header ${index + 1} JSON path`"
							:disabled="disabled"
					/></label>
					<Button
						type="button"
						variant="ghost"
						:disabled="disabled"
						@click="headers.splice(index, 1)"
						>Remove delivery header {{ index + 1 }}</Button
					>
				</div>
				<Button
					type="button"
					variant="outline"
					:disabled="disabled || headers.length >= 10"
					@click="addHeader"
					>Add delivery header</Button
				>
				<p class="field-hint">
					Up to 10 unique headers; values up to 4096 UTF-8 bytes. System headers are
					reserved. Authorization is allowed only for webhooks without Entra
					authentication.
				</p>
			</template>
		</template>
		<p v-if="current?.deadLetter" class="field-hint">
			Current dead-letter storage: {{ current.deadLetter.resourceId }} /
			{{ current.deadLetter.containerName }} ·
			{{ current.deadLetter.identity?.type ?? 'Unsupported identity' }}
		</p>
		<label
			>Dead-letter destination<select
				v-model="deadMode"
				aria-label="Dead-letter destination"
				:disabled="disabled"
			>
				<option value="keep">
					{{
						creating
							? 'No dead-letter destination'
							: 'Keep existing dead-letter settings'
					}}
				</option>
				<option value="set">Configure blob storage</option>
				<option v-if="!creating" value="clear">Disable dead-lettering</option>
			</select></label
		>
		<template v-if="deadMode === 'set'">
			<label
				>Dead-letter storage account ARM ID<Input
					v-model="deadResource"
					:disabled="disabled"
			/></label>
			<label
				>Dead-letter blob container<Input v-model="deadContainer" :disabled="disabled"
			/></label>
			<label
				>Dead-letter identity<select
					v-model="deadIdentity"
					aria-label="Dead-letter identity"
					:disabled="disabled"
				>
					<option>SystemAssigned</option>
					<option>UserAssigned</option>
				</select></label
			>
			<label v-if="deadIdentity === 'UserAssigned'"
				>Dead-letter user-assigned identity ARM ID<Input
					v-model="deadUser"
					:disabled="disabled"
			/></label>
			<p class="field-hint">
				Use an existing storage account and container. The namespace identity needs Storage
				Blob Data Contributor access. This editor does not create storage or grant roles.
			</p>
		</template>
		<p v-if="deadMode === 'clear'" class="form-warning">
			Events that exhaust retries or retention may be dropped when dead-lettering is disabled.
		</p>
	</section>
</template>
<style scoped>
.eg-delivery-editor {
	display: flex;
	flex-direction: column;
	gap: 12px;
	border-top: 1px solid var(--border);
	padding-top: 16px;
}
</style>
