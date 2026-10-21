<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import EventAdminFeedback from './EventAdminFeedback.vue'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventHubsAdmin } from '@/features/event-hubs/stores/event-hubs-admin'
import {
	eventAdminChangeSchema,
	eventAdminConfirmation,
	type EventAdminDetails,
	type EventPolicyPage,
	type EventPolicyKeyRequest,
} from '@shared/contracts/event-hubs/administration'
import type { AuthorizationKey, AuthorizationRight } from '@shared/authorization'
const eh = useEventHubs(),
	admin = useEventHubsAdmin()
const visible = ref(false),
	hub = ref(''),
	page = ref<EventPolicyPage>({ items: [], continuationToken: null }),
	current = ref<EventAdminDetails>(),
	mode = ref<'create' | 'update' | 'delete' | 'regenerate' | 'keys'>(),
	name = ref(''),
	rights = ref<AuthorizationRight[]>(['Send']),
	keyType = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey'),
	confirmation = ref(''),
	acknowledged = ref(false),
	secret = ref<AuthorizationKey>(),
	notice = ref('')
let revealGeneration = 0,
	hideTimer: ReturnType<typeof setTimeout> | undefined
const target = computed<EventPolicyKeyRequest['target']>(() => ({
	kind: 'policy',
	hubName: hub.value,
	name: name.value,
}))
const phrase = computed(() => eventAdminConfirmation(mode.value ?? '', target.value, keyType.value))
const parsed = computed(() =>
	eventAdminChangeSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: eh.connection?.connectionId,
		target: target.value,
		action: mode.value,
		expectedRevision: mode.value === 'create' ? null : (current.value?.revision ?? null),
		settings: null,
		userMetadata: null,
		rights: mode.value === 'create' || mode.value === 'update' ? rights.value : null,
		keyType: mode.value === 'regenerate' ? keyType.value : null,
		acknowledged: acknowledged.value,
		confirmation: confirmation.value,
	}),
)
function hide() {
	revealGeneration++
	secret.value = undefined
	clearTimeout(hideTimer)
}
function reset() {
	hide()
	current.value = undefined
	mode.value = undefined
	confirmation.value = ''
	acknowledged.value = false
	notice.value = ''
}
watch(
	[rights, name, keyType, hub, mode],
	() => {
		hide()
		acknowledged.value = false
		confirmation.value = ''
		notice.value = ''
	},
	{ deep: true, flush: 'sync' },
)
watch(
	() => eh.connection?.connectionId,
	() => {
		visible.value = false
		page.value = { items: [], continuationToken: null }
		reset()
	},
	{ flush: 'sync' },
)
onBeforeUnmount(hide)
async function load(more = false) {
	hide()
	const value = await admin.policies(hub.value, more ? page.value.continuationToken : null)
	if (value && visible.value)
		page.value = more
			? {
					items: [...page.value.items, ...value.items],
					continuationToken: value.continuationToken,
				}
			: value
}
async function show(hubName = '') {
	if (eh.busy) return
	reset()
	hub.value = hubName
	page.value = { items: [], continuationToken: null }
	visible.value = true
	await admin.loadContext()
	await load()
}
function close(value: boolean) {
	if (eh.busy) return
	visible.value = value
	if (!value) reset()
}
function create() {
	reset()
	mode.value = 'create'
	name.value = ''
	rights.value = ['Send']
}
async function choose(rule: string, action: NonNullable<typeof mode.value>) {
	hide()
	const value = await admin.get({ kind: 'policy', hubName: hub.value, name: rule })
	if (value && visible.value) {
		reset()
		name.value = rule
		rights.value = [...(value.rights ?? [])]
		current.value = value
		mode.value = action
	}
}
function setRight(right: AuthorizationRight, enabled: boolean) {
	rights.value =
		right === 'Manage' && enabled
			? ['Listen', 'Send', 'Manage']
			: enabled
				? [...new Set([...rights.value, right])]
				: rights.value.filter((r) => r !== right && (right === 'Manage' || r !== 'Manage'))
}
async function reveal() {
	hide()
	const ticket = revealGeneration
	const value = await admin.key(target.value, keyType.value)
	if (value && visible.value && mode.value === 'keys' && ticket === revealGeneration) {
		secret.value = value
		hideTimer = setTimeout(hide, 30000)
	}
}
async function copy(format: 'key' | 'connectionString') {
	hide()
	if ((await admin.copy(target.value, keyType.value, format)) === null)
		notice.value = 'Copied. Clipboard history or other applications may retain this credential.'
}
async function submit() {
	if (!parsed.value.success || admin.blocked) return
	hide()
	const result = await admin.change(parsed.value.data)
	acknowledged.value = false
	confirmation.value = ''
	if (result?.status === 'confirmed') {
		reset()
		await load()
	}
}
defineExpose({ show })
</script>
<template>
	<Dialog :open="visible" @update:open="close"
		><DialogContent
			class="message-inspection-dialog event-policy-dialog"
			:show-close-button="!eh.busy"
			@escape-key-down="eh.busy && $event.preventDefault()"
			@interact-outside="eh.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Event Hubs SAS policies</DialogTitle
				><DialogDescription
					>{{ eh.connection?.namespace }} / {{ hub || 'namespace' }}. Policy rights
					control SAS data access; administration uses Entra management
					permissions.</DialogDescription
				></DialogHeader
			>
			<EventAdminFeedback />
			<p v-if="admin.context?.localAuthDisabled" class="inspector-warning">
				Local/SAS authentication is disabled on this namespace. Policies and keys cannot
				grant SAS access until the namespace configuration allows it.
			</p>
			<div class="explorer-actions">
				<Button variant="outline" :disabled="admin.blocked" @click="create"
					>Create SAS policy</Button
				><Button variant="outline" :disabled="!!eh.busy" @click="load()"
					>Refresh SAS policies</Button
				>
			</div>
			<div class="policy-list">
				<table class="property-table" aria-label="Event Hubs SAS policies">
					<thead>
						<tr>
							<th>Policy</th>
							<th>Rights</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="policy in page.items" :key="policy.name">
							<th>{{ policy.name }}</th>
							<td>{{ policy.rights.join(', ') }}</td>
							<td class="policy-actions">
								<Button
									variant="ghost"
									size="sm"
									:disabled="!!eh.busy"
									:aria-label="`Edit SAS policy ${policy.name}`"
									@click="choose(policy.name, 'update')"
									>Edit</Button
								><Button
									variant="ghost"
									size="sm"
									:disabled="!!eh.busy"
									:aria-label="`Keys for SAS policy ${policy.name}`"
									@click="choose(policy.name, 'keys')"
									>Keys</Button
								><Button
									variant="ghost"
									size="sm"
									:disabled="admin.blocked"
									:aria-label="`Rotate SAS policy ${policy.name}`"
									@click="choose(policy.name, 'regenerate')"
									>Rotate key</Button
								><Button
									variant="ghost"
									size="sm"
									:disabled="admin.blocked"
									:aria-label="`Delete SAS policy ${policy.name}`"
									@click="choose(policy.name, 'delete')"
									>Delete</Button
								>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p v-if="!page.items.length && !eh.busy" class="explorer-note">
				No policies loaded for this scope.
			</p>
			<Button
				v-if="page.continuationToken"
				variant="outline"
				:disabled="!!eh.busy"
				@click="load(true)"
				>More SAS policies</Button
			>
			<section v-if="mode" class="policy-editor">
				<label
					>Policy name<Input
						v-model="name"
						aria-label="Event SAS policy name"
						maxlength="50"
						:disabled="mode !== 'create' || !!eh.busy"
				/></label>
				<div v-if="mode === 'create' || mode === 'update'" class="explorer-actions">
					<label
						v-for="right in ['Send', 'Listen', 'Manage'] as const"
						:key="right"
						class="check-row"
						><input
							type="checkbox"
							:checked="rights.includes(right)"
							:disabled="!!eh.busy"
							@change="setRight(right, ($event.target as HTMLInputElement).checked)"
						/>{{ right }}</label
					>
					<p class="explorer-note">Manage includes Send and Listen.</p>
				</div>
				<label v-if="mode === 'keys' || mode === 'regenerate'"
					>Key slot<select
						v-model="keyType"
						aria-label="Event SAS key slot"
						:disabled="!!eh.busy"
					>
						<option>PrimaryKey</option>
						<option>SecondaryKey</option>
					</select></label
				>
				<template v-if="mode === 'keys'">
					<p class="explorer-note">
						Only the selected key slot is revealed. The display clears after 30 seconds,
						when switching policies or slots, and when closing this dialog.
					</p>
					<div class="explorer-actions">
						<Button variant="outline" :disabled="!!eh.busy" @click="reveal"
							>Reveal selected Event Hubs key</Button
						><Button variant="outline" :disabled="!!eh.busy" @click="copy('key')"
							>Copy Event Hubs key</Button
						><Button
							variant="outline"
							:disabled="!!eh.busy"
							@click="copy('connectionString')"
							>Copy Event Hubs connection string</Button
						><Button v-if="secret" variant="ghost" @click="hide"
							>Hide Event Hubs key</Button
						>
					</div>
					<div v-if="secret" aria-label="Revealed Event Hubs credential">
						<label
							>Selected key<textarea
								readonly
								:value="secret.key"
								aria-label="Revealed Event Hubs key"
							/></label
						><label
							>Connection string<textarea
								readonly
								:value="secret.connectionString"
								aria-label="Revealed Event Hubs connection string"
							/>
						</label>
					</div>
					<p v-if="notice" role="status">{{ notice }}</p>
				</template>
				<template v-else>
					<p v-if="mode === 'delete' || mode === 'update'" class="inspector-warning">
						{{
							mode === 'delete'
								? 'Deleting this policy invalidates clients using either key.'
								: 'Changing rights can interrupt clients using this policy.'
						}}
					</p>
					<p v-if="mode === 'regenerate'" class="inspector-warning">
						Regenerating {{ keyType }} invalidates that key and its connection string.
						Move clients to the other slot first. An interrupted rotation may already
						have succeeded; do not retry it automatically.
					</p>
					<template v-if="mode === 'delete' || mode === 'regenerate'"
						><p class="mono">Type {{ phrase }}</p>
						<Input
							v-model="confirmation"
							aria-label="Event SAS action confirmation"
							:disabled="!!eh.busy"
					/></template>
					<label class="check-row"
						><input v-model="acknowledged" type="checkbox" :disabled="admin.blocked" />I
						reviewed this policy action and its effect on clients.</label
					>
					<p v-if="acknowledged && !parsed.success" role="alert" class="error-banner">
						{{ parsed.error.issues[0].message }}
					</p>
					<Button
						:variant="
							mode === 'delete' || mode === 'regenerate' ? 'destructive' : 'default'
						"
						:disabled="admin.blocked || !admin.context || !parsed.success"
						@click="submit"
						>{{
							mode === 'create'
								? 'Create Event Hubs SAS policy'
								: mode === 'update'
									? 'Save Event Hubs SAS policy'
									: mode === 'delete'
										? 'Delete Event Hubs SAS policy'
										: 'Regenerate Event Hubs key'
						}}</Button
					>
				</template>
			</section>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.event-policy-dialog {
	max-width: min(1100px, calc(100vw - 3rem));
}
.policy-list {
	max-height: 240px;
	overflow: auto;
}
.policy-actions {
	display: flex;
	gap: 0.3rem;
	flex-wrap: wrap;
}
.policy-editor {
	display: grid;
	gap: 0.8rem;
	border-top: 1px solid var(--border);
	padding-top: 0.8rem;
}
label {
	display: grid;
	gap: 0.3rem;
	font-size: 0.85rem;
}
.check-row {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
}
select,
textarea {
	width: 100%;
	padding: 0.5rem;
	border: 1px solid var(--border);
	border-radius: 0.4rem;
	background: var(--background);
	color: var(--foreground);
}
textarea {
	overflow-wrap: anywhere;
}
.mono {
	overflow-wrap: anywhere;
}
</style>
