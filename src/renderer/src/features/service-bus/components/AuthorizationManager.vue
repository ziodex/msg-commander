<script setup lang="ts">
import { serviceBusApi } from '@/features/service-bus/api'

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { useAuthorization } from '@/features/service-bus/stores/authorization'
import {
	authorizationConfirmation,
	authorizationContextSchema,
	authorizationRightsSchema,
	createAuthorizationSchema,
	type AuthorizationTarget,
	type AuthorizationRule,
	type AuthorizationPage,
	type AuthorizationKey,
	type AuthorizationRight,
	type AuthorizationKeyType,
} from '@shared/authorization'

const sb = useServiceBus(),
	workspace = useWorkspace(),
	sas = useAuthorization()
const open = ref(false),
	configuring = ref(false)
const target = ref<AuthorizationTarget>({ kind: 'namespace' })
const page = ref<AuthorizationPage>(),
	current = ref<AuthorizationRule>()
const mode = ref<'create' | 'update' | 'delete' | 'regenerate' | 'keys'>()
const name = ref(''),
	rights = ref<AuthorizationRight[]>(['Send'])
const keyType = ref<AuthorizationKeyType>('PrimaryKey'),
	secret = ref<AuthorizationKey>()
const acknowledged = ref(false),
	validation = ref(''),
	notice = ref('')
const context = reactive({ resourceId: '', tenantId: '', clientId: '' })
let hideTimer: ReturnType<typeof setTimeout> | undefined
let revealGeneration = 0
const frozen = computed(() => !!sb.busy || sas.outcome?.status === 'unknown')
const activeJob = computed(() =>
	workspace.jobs.find((job) => job.status === 'running' && job.label === sb.busy),
)
const selectedTarget = computed<AuthorizationTarget | undefined>(() => {
	const entity = sb.selected?.target
	return entity && entity.kind !== 'subscription'
		? { kind: entity.kind, name: entity.name }
		: undefined
})
const phrase = computed(() =>
	mode.value && ['update', 'delete', 'regenerate'].includes(mode.value)
		? authorizationConfirmation(
				mode.value as 'update' | 'delete' | 'regenerate',
				sas.session?.resourceId ?? '',
				target.value,
				name.value,
				keyType.value,
			)
		: '',
)
function hide() {
	revealGeneration++
	secret.value = undefined
	clearTimeout(hideTimer)
}
function resetForm() {
	hide()
	mode.value = undefined
	current.value = undefined
	acknowledged.value = false
	validation.value = ''
	notice.value = ''
}
function close(value: boolean) {
	if (sb.busy) return
	open.value = value
	if (!value) resetForm()
}
async function load() {
	hide()
	const result = await sas.list(target.value)
	if (result) page.value = result
}
async function show(scope: AuthorizationTarget) {
	resetForm()
	target.value = scope
	page.value = undefined
	open.value = true
	configuring.value = !sas.session
	if (!context.tenantId) context.tenantId = workspace.selected?.tenantId ?? ''
	if (!context.clientId) context.clientId = workspace.selected?.clientId ?? ''
	if (sas.session) await load()
}
async function openLogin() {
	const result = await serviceBusApi.openDeviceLogin()
	if (!result.ok) sas.error = result.error.message
}
async function connect() {
	validation.value = ''
	const parsed = authorizationContextSchema.safeParse(context)
	if (!parsed.success) {
		validation.value =
			'Enter the full namespace resource ID, tenant and public client application UUID.'
		return
	}
	if (await sas.connect(parsed.data)) {
		configuring.value = false
		resetForm()
		await load()
	}
}
function create() {
	resetForm()
	mode.value = 'create'
	name.value = ''
	rights.value = ['Send']
}
async function choose(rule: string, action: NonNullable<typeof mode.value>) {
	hide()
	const value = await sas.get(target.value, rule)
	if (!value) return
	resetForm()
	current.value = value
	name.value = value.name
	rights.value = [...value.rights]
	mode.value = action
}
function setRight(right: AuthorizationRight, enabled: boolean) {
	if (right === 'Manage' && enabled) rights.value = ['Listen', 'Send', 'Manage']
	else
		rights.value = enabled
			? [...new Set([...rights.value, right])]
			: rights.value.filter((r) => r !== right)
}
async function reveal() {
	hide()
	notice.value = ''
	const ticket = revealGeneration
	const value = await sas.key(target.value, name.value, keyType.value)
	if (value && open.value && mode.value === 'keys' && ticket === revealGeneration) {
		secret.value = value
		hideTimer = setTimeout(hide, 30000)
	}
}
async function copy(format: 'key' | 'connectionString') {
	notice.value = ''
	if ((await sas.copy(target.value, name.value, keyType.value, format)) === null)
		notice.value =
			'Copied. The clipboard may be read by other applications or clipboard history.'
}
async function submit() {
	if (!mode.value || mode.value === 'keys' || frozen.value) return
	hide()
	validation.value = ''
	if (mode.value === 'create' || mode.value === 'update') {
		const parsed = authorizationRightsSchema.safeParse(rights.value)
		if (!parsed.success) {
			validation.value = 'Choose Send or Listen. Manage includes both rights.'
			return
		}
		if (!createAuthorizationSchema.shape.name.safeParse(name.value).success) {
			validation.value =
				'Use 1–50 letters, numbers, underscores, hyphens or periods for the rule name.'
			return
		}
	}
	if (phrase.value && !acknowledged.value) return
	const result = await sas.change(
		mode.value,
		target.value,
		name.value,
		rights.value,
		current.value?.revision ?? '',
		phrase.value,
		keyType.value,
	)
	if (result?.status === 'confirmed') {
		resetForm()
		await load()
	}
}
watch(keyType, () => {
	hide()
	acknowledged.value = false
	notice.value = ''
})
watch(
	() => sb.connection?.connectionId,
	() => {
		open.value = false
		resetForm()
		page.value = undefined
		context.resourceId = ''
		context.tenantId = ''
		context.clientId = ''
	},
)
watch(
	[phrase, rights],
	() => {
		acknowledged.value = false
	},
	{ deep: true },
)
onBeforeUnmount(hide)
</script>

<template>
	<div class="explorer-actions">
		<Button
			size="sm"
			variant="outline"
			:disabled="!!sb.busy"
			@click="show({ kind: 'namespace' })"
			>Namespace SAS rules</Button
		>
		<Button
			v-if="selectedTarget"
			size="sm"
			variant="outline"
			:disabled="!!sb.busy"
			@click="show(selectedTarget)"
			>Selected {{ selectedTarget.kind }} SAS rules</Button
		>
	</div>
	<Dialog :open="open" @update:open="close">
		<DialogContent
			class="message-dialog entity-dialog rule-dialog"
			@escape-key-down="sb.busy && $event.preventDefault()"
			@interact-outside="sb.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>SAS authorization rules</DialogTitle
				><DialogDescription
					>Manage access to this namespace, queue or topic. Changes can disrupt clients
					that use these policies.</DialogDescription
				></DialogHeader
			>
			<div class="write-destination">
				<strong>{{ sb.connection?.namespace }}</strong
				><span
					>{{ target.kind
					}}{{
						target.kind !== 'namespace' ? ' / ' + target.name : ' / all entities'
					}}</span
				>
			</div>
			<p v-if="sas.error" class="form-error" role="alert">{{ sas.error }}</p>
			<p v-if="validation" class="form-error" role="alert">{{ validation }}</p>
			<form v-if="configuring" class="connection-form" @submit.prevent="connect">
				<p class="explorer-note">
					These operations use Azure Resource Manager. Sign in with an Entra account that
					has authorization-rule permissions, even if messaging uses a SAS connection.
					Settings and tokens stay in this session. This does not change your messaging
					credentials.
				</p>
				<label
					>Namespace resource ID<Input
						v-model="context.resourceId"
						aria-label="Namespace resource ID"
						placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.ServiceBus/namespaces/…"
						:disabled="!!sb.busy"
				/></label>
				<div class="form-grid">
					<label
						>Management tenant ID<Input
							v-model="context.tenantId"
							aria-label="Management tenant ID"
							:disabled="!!sb.busy" /></label
					><label
						>Management application ID<Input
							v-model="context.clientId"
							aria-label="Management application ID"
							:disabled="!!sb.busy"
					/></label>
				</div>
				<p class="explorer-note">
					Use a public client application that permits device-code sign-in to Azure
					management. Namespace read access is checked on sign-in; each operation checks
					its own permissions. The device code appears in Operations.
				</p>
				<Button type="submit" :disabled="frozen">Sign in to management</Button>
			</form>
			<template v-else>
				<p class="explorer-note sas-resource">{{ sas.session?.resourceId }}</p>
				<p class="explorer-note">
					Namespace rules apply to all entities. Manage includes Send and Listen. This
					list contains only rules directly on the selected scope; inherited policies
					remain effective. SAS policies do not override a namespace's disabled local
					authentication.
				</p>
				<template v-if="!mode">
					<div class="explorer-actions">
						<Button :disabled="frozen" @click="create">Create SAS rule</Button
						><Button variant="outline" :disabled="!!sb.busy" @click="load"
							>Refresh SAS rules</Button
						><Button variant="ghost" :disabled="frozen" @click="configuring = true"
							>Change management sign-in</Button
						>
					</div>
					<div class="message-table-wrap">
						<table class="message-table" aria-label="SAS authorization rules">
							<thead>
								<tr>
									<th>Rule</th>
									<th>Rights</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="rule in page?.items" :key="rule.name">
									<td>{{ rule.name }}</td>
									<td>{{ rule.rights.join(', ') }}</td>
									<td class="explorer-actions">
										<Button
											size="sm"
											variant="outline"
											:disabled="frozen"
											:aria-label="`Edit SAS rule ${rule.name}`"
											@click="choose(rule.name, 'update')"
											>Edit</Button
										>
										<Button
											size="sm"
											variant="outline"
											:disabled="!!sb.busy"
											:aria-label="`Keys for SAS rule ${rule.name}`"
											@click="choose(rule.name, 'keys')"
											>Keys</Button
										>
										<Button
											size="sm"
											variant="destructive"
											:disabled="frozen"
											:aria-label="`Delete SAS rule ${rule.name}`"
											@click="choose(rule.name, 'delete')"
											>Delete</Button
										>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-if="page && !page.items.length" class="explorer-note">
						No direct SAS rules on this scope.
					</p>
				</template>
				<form v-else class="connection-form" @submit.prevent="submit">
					<h3>{{ mode === 'create' ? 'Create SAS rule' : name }}</h3>
					<label v-if="mode === 'create'"
						>SAS rule name<Input
							v-model="name"
							aria-label="SAS rule name"
							:maxlength="50"
							:disabled="frozen"
					/></label>
					<fieldset v-if="mode === 'create' || mode === 'update'" :disabled="frozen">
						<legend>Access rights</legend>
						<label
							v-for="right in ['Listen', 'Send', 'Manage'] as const"
							:key="right"
							class="checkbox-label"
							><input
								type="checkbox"
								:checked="rights.includes(right)"
								:disabled="right !== 'Manage' && rights.includes('Manage')"
								@change="
									setRight(right, ($event.target as HTMLInputElement).checked)
								"
							/>{{ right }}</label
						>
					</fieldset>
					<template v-if="mode === 'keys' || mode === 'regenerate'">
						<label
							>Key slot<select
								v-model="keyType"
								aria-label="Key slot"
								:disabled="!!sb.busy"
							>
								<option value="PrimaryKey">Primary key</option>
								<option value="SecondaryKey">Secondary key</option>
							</select></label
						>
						<template v-if="mode === 'keys'">
							<p class="explorer-note">
								Keys are hidden until requested and automatically hidden after 30
								seconds. Copying places the selected credential on the system
								clipboard.
							</p>
							<div class="explorer-actions">
								<Button
									type="button"
									variant="outline"
									:disabled="!!sb.busy"
									@click="reveal"
									>Reveal selected key</Button
								><Button
									type="button"
									variant="outline"
									:disabled="!!sb.busy"
									@click="copy('key')"
									>Copy selected key</Button
								><Button
									type="button"
									variant="outline"
									:disabled="!!sb.busy"
									@click="copy('connectionString')"
									>Copy connection string</Button
								><Button v-if="secret" type="button" variant="ghost" @click="hide"
									>Hide keys</Button
								>
							</div>
							<template v-if="secret"
								><label
									>Selected key<Input
										:model-value="secret.key"
										readonly
										aria-label="Revealed SAS key"
										autocomplete="off" /></label
								><label
									>Selected connection string<textarea
										:value="secret.connectionString"
										readonly
										aria-label="Revealed SAS connection string"
										autocomplete="off"
										spellcheck="false"
									></textarea></label
							></template>
							<p v-if="notice" role="status" class="explorer-note">{{ notice }}</p>
							<Button
								type="button"
								variant="destructive"
								:disabled="frozen"
								@click="choose(name, 'regenerate')"
								>Regenerate selected key…</Button
							>
						</template>
					</template>
					<template v-if="phrase">
						<p class="inspector-warning">
							{{
								mode === 'regenerate'
									? 'This replaces the selected key. Clients and tokens using it can lose access; the other key is retained. Migrate clients to the other slot before rotating.'
									: mode === 'delete'
										? 'Deleting this policy revokes both key slots and can disconnect clients.'
										: 'Changing rights can revoke client access or grant broader access.'
							}}
							Saved connection strings are not updated automatically.
						</p>
						<p class="explorer-note">
							Rights are rechecked before writing. Concurrent edits or key rotations
							cannot be excluded atomically.
						</p>

						<label class="checkbox-label"
							><input v-model="acknowledged" type="checkbox" :disabled="frozen" />I
							understand this can revoke access or change client permissions.</label
						>
					</template>
					<div class="explorer-actions">
						<Button
							type="button"
							variant="outline"
							:disabled="!!sb.busy"
							@click="resetForm"
							>Back to SAS rules</Button
						><Button
							v-if="mode !== 'keys'"
							type="submit"
							:variant="
								mode === 'delete' || mode === 'regenerate'
									? 'destructive'
									: 'default'
							"
							:disabled="frozen || (!!phrase && !acknowledged)"
							>{{
								mode === 'create'
									? 'Create SAS rule'
									: mode === 'update'
										? 'Save SAS rights'
										: mode === 'delete'
											? 'Delete SAS rule'
											: 'Regenerate key'
							}}</Button
						>
					</div>
				</form>
				<div v-if="sas.outcome" class="inspector-warning" role="status">
					<strong>{{ sas.outcome.status }}</strong> · {{ sas.outcome.summary }}
					<p>Receipt: {{ sas.outcome.operationId }}</p>
					<Button
						variant="outline"
						size="sm"
						:disabled="!!sb.busy"
						@click="sas.checkOutcome"
						>Check SAS result</Button
					>
					<p v-if="sas.outcome.status === 'unknown'">
						Further SAS changes are blocked in this connection. Verify Azure state
						before reconnecting; a missing receipt or unchanged rights cannot prove that
						a key was not rotated.
					</p>
				</div>
			</template>
			<p v-if="sb.busy" class="explorer-note" role="status">
				{{ sb.busy }}… Cancellation is available in Operations and cannot undo a dispatched
				change.
			</p>
			<div v-if="activeJob" class="explorer-actions">
				<template v-if="activeJob.code"
					><span
						>Device code: <strong>{{ activeJob.code }}</strong></span
					><Button type="button" variant="outline" @click="openLogin"
						>Open device sign-in</Button
					></template
				>
				<Button type="button" variant="outline" @click="workspace.cancel(activeJob.id)"
					>Cancel SAS operation</Button
				>
			</div>
		</DialogContent>
	</Dialog>
</template>

<style scoped>
.sas-resource {
	display: block;
	overflow-wrap: anywhere;
	white-space: normal;
	font-size: 12px;
}
textarea {
	min-height: 72px;
	width: 100%;
	overflow-wrap: anywhere;
}
</style>
