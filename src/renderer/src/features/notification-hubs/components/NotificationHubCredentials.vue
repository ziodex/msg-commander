<script setup lang="ts">
import { notificationHubsApi } from '@/features/notification-hubs/api'

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
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import { useWorkspace } from '@/shared/workspace/store'
import type {
	NotificationHubTarget,
	NotificationHubOutcome,
} from '@shared/contracts/notification-hubs/core'
import {
	credentialLabels,
	credentialDraftSchema,
	type CredentialProvider,
	type CredentialStatus,
	type CredentialArtifact,
} from '@shared/contracts/notification-hubs/credentials'
const props = defineProps<{ target: NotificationHubTarget }>(),
	emit = defineEmits<{ close: [] }>(),
	nh = useNotificationHubs()
const provider = ref<CredentialProvider>('apns-token'),
	status = ref<CredentialStatus>(),
	artifact = ref<CredentialArtifact>(),
	password = ref(''),
	acknowledged = ref(false),
	result = ref<NotificationHubOutcome>(),
	error = ref('')
const remove = ref(false)
const fields = reactive({
	environment: 'sandbox' as 'sandbox' | 'production',
	keyId: '',
	teamId: '',
	bundleId: '',
	packageSid: '',
	secretKey: '',
	clientId: '',
	clientSecret: '',
	apiKey: '',
	subject: '',
	vapidPublicKey: '',
	vapidPrivateKey: '',
	appSecret: '',
	endpoint: 'https://api.xmpush.xiaomi.com/v3/message/regid',
})
const workspace = useWorkspace(),
	signIn = computed(() =>
		workspace.jobs.find(
			(job) => job.id === nh.operationId && job.status === 'running' && job.code,
		),
	)
async function login() {
	const response = await notificationHubsApi.openDeviceLogin()
	if (!response.ok) error.value = response.error.message
}
const connectionId = nh.connection!.connectionId,
	target = JSON.parse(JSON.stringify(props.target)) as NotificationHubTarget
let disposed = false
const importing = computed(() =>
	['apns-token', 'apns-certificate', 'fcm-v1', 'mpns-certificate'].includes(provider.value),
)
const draft = computed(() => {
	if (remove.value || provider.value === 'gcm-legacy')
		return { provider: provider.value, remove: true as const }
	const common = { provider: provider.value, artifactId: artifact.value?.artifactId }
	switch (provider.value) {
		case 'apns-token':
			return {
				...common,
				environment: fields.environment,
				keyId: fields.keyId,
				teamId: fields.teamId,
				bundleId: fields.bundleId,
			}
		case 'apns-certificate':
			return { ...common, environment: fields.environment }
		case 'fcm-v1':
		case 'mpns-certificate':
			return common
		case 'wns':
			return {
				provider: provider.value,
				packageSid: fields.packageSid,
				secretKey: fields.secretKey,
			}
		case 'adm':
			return {
				provider: provider.value,
				clientId: fields.clientId,
				clientSecret: fields.clientSecret,
			}
		case 'browser':
			return {
				provider: provider.value,
				subject: fields.subject,
				vapidPublicKey: fields.vapidPublicKey,
				vapidPrivateKey: fields.vapidPrivateKey,
			}
		case 'xiaomi':
			return {
				provider: provider.value,
				appSecret: fields.appSecret,
				endpoint: fields.endpoint,
			}
		default:
			return { provider: provider.value, apiKey: fields.apiKey, secretKey: fields.secretKey }
	}
})
const valid = computed(() => credentialDraftSchema.safeParse(draft.value))
function discard() {
	const value = artifact.value
	artifact.value = undefined
	if (value)
		void notificationHubsApi
			.discardNotificationHubCredential({
				id: crypto.randomUUID(),
				connectionId,
				target,
				artifactId: value.artifactId,
			})
			.catch(() => {})
}
function clearSecrets() {
	password.value = ''
	for (const name of [
		'secretKey',
		'clientSecret',
		'apiKey',
		'packageSid',
		'clientId',
		'subject',
		'vapidPublicKey',
		'vapidPrivateKey',
		'appSecret',
	] as const)
		fields[name] = ''
	discard()
}
async function load() {
	status.value = undefined
	error.value = ''
	acknowledged.value = false
	const selected = provider.value
	const value = await nh.run('Inspect provider credential status', (id, connectionId) =>
		notificationHubsApi.getNotificationHubCredentials({
			id,
			connectionId,
			target,
			provider: selected,
		}),
	)
	if (!disposed && selected === provider.value) status.value = value
}
watch(
	provider,
	() => {
		clearSecrets()
		remove.value = provider.value === 'gcm-legacy'
		void load()
	},
	{ immediate: true },
)
watch(remove, () => {
	clearSecrets()
	acknowledged.value = false
})
watch(
	draft,
	() => {
		acknowledged.value = false
		error.value = ''
	},
	{ deep: true },
)
async function importFile() {
	if (!importing.value) return
	discard()
	acknowledged.value = false
	error.value = ''
	const selected = provider.value as
			'apns-token' | 'apns-certificate' | 'fcm-v1' | 'mpns-certificate',
		secret = password.value
	password.value = ''
	const value = await nh.run('Import private provider credential', (id, connectionId) =>
		notificationHubsApi.importNotificationHubCredential({
			id,
			connectionId,
			target,
			provider: selected,
			password: secret,
		}),
	)
	if (!disposed && selected === provider.value && value?.artifact) artifact.value = value.artifact
}
async function save() {
	if (
		!status.value ||
		!valid.value.success ||
		!acknowledged.value ||
		nh.blocked ||
		(remove.value && !status.value.configured)
	)
		return
	const value = await nh.change({
		action: 'credentials',
		target,
		expectedRevision: status.value.revision,
		draft: valid.value.data,
		acknowledged: true,
	})
	if (disposed) return
	if (value) {
		result.value = value
		clearSecrets()
		acknowledged.value = false
	}
}
async function close() {
	if (nh.busy) return
	const value = result.value
	emit('close')
	if (value) await nh.afterChange(value)
}
onBeforeUnmount(() => {
	disposed = true
	clearSecrets()
})
</script>
<template>
	<Dialog :open="true" @update:open="!$event && close()"
		><DialogContent class="sm:max-w-[780px] provider-dialog" :show-close-button="!nh.busy"
			><DialogHeader
				><DialogTitle>Provider credentials · {{ target.scope.name }}</DialogTitle
				><DialogDescription
					>Replace or remove one provider's configuration. Existing credentials are
					write-only and are never revealed or saved in the connection
					profile.</DialogDescription
				></DialogHeader
			>
			<div class="provider-body">
				<div v-if="nh.busy" role="status">{{ nh.busy }}…</div>
				<section v-if="signIn" aria-label="Provider Microsoft sign-in">
					<p>Sign in again to continue this provider operation.</p>
					<p class="device-code">{{ signIn.code }}</p>
					<p v-if="signIn.expiresOn" class="field-hint">
						Expires {{ new Date(signIn.expiresOn).toLocaleTimeString() }}
					</p>
					<Button variant="outline" @click="login">Open Microsoft sign-in</Button>
				</section>
				<template v-if="result"
					><h3>
						{{
							result.status === 'confirmed'
								? 'Provider update acknowledged'
								: result.status === 'unknown'
									? 'Provider outcome unknown'
									: result.status === 'cancelled'
										? 'Provider update cancelled'
										: 'Provider update failed'
						}}
					</h3>
					<p role="status">{{ result.summary }}</p>
					<p class="field-hint">Receipt: {{ result.operationId }}</p></template
				>
				<template v-else>
					<label
						>Notification provider<select
							aria-label="Notification provider"
							v-model="provider"
							:disabled="!!nh.busy"
						>
							<option
								v-for="(label, key) in credentialLabels"
								:key="key"
								:value="key"
							>
								{{ label }}
							</option>
						</select></label
					>
					<p v-if="status" class="field-hint">
						{{
							status.configured
								? 'Azure reports a credential object for this provider.'
								: 'Azure reports no credential object for this provider.'
						}}
						Secret values and validity are not inferred from this status.
					</p>
					<p v-if="provider === 'fcm-v1'" class="field-hint">
						FCM v1 uses Azure ARM 2023-10-01-preview. Import the Firebase
						service-account JSON with project_id, client_email and private_key. Legacy
						GCM settings and registrations are preserved; this does not migrate them.
					</p>
					<p v-if="provider.startsWith('apns-')" class="field-hint">
						APNS token and certificate modes share one provider configuration. Saving
						replaces the current APNS mode. Select the environment that matches your
						app.
					</p>
					<p v-if="provider === 'mpns-certificate'" class="field-hint">
						Microsoft no longer supports MPNS. Existing registrations and XML can be
						preserved or exported. Legacy credential requests do not establish working
						device delivery.
					</p>
					<p v-if="provider === 'gcm-legacy'" class="field-hint">
						GCM/FCM is retired. Configure FCM v1 with a service account and current
						registration tokens. Remove old credentials after checking your migration.
					</p>
					<label v-if="provider !== 'gcm-legacy'" class="provider-confirm"
						><input type="checkbox" v-model="remove" :disabled="!!nh.busy" />Remove this
						provider's credentials</label
					>
					<p v-if="remove" class="form-warning">
						Request removal of {{ credentialLabels[provider] }} from
						{{ target.scope.name }}. This may stop delivery for this provider.
						Registrations remain available for export or migration.
						<template v-if="provider.startsWith('apns-')"
							>Removing either APNS mode clears the shared APNS
							configuration.</template
						>
					</p>
					<template v-if="!remove">
						<template v-if="provider.startsWith('apns-')"
							><label
								>APNS environment<select
									aria-label="APNS environment"
									v-model="fields.environment"
									:disabled="!!nh.busy"
								>
									<option value="sandbox">Sandbox</option>
									<option value="production">Production</option>
								</select></label
							></template
						>
						<div v-if="provider === 'apns-token'" class="provider-fields">
							<label
								>APNS Key ID<Input
									v-model="fields.keyId"
									maxlength="10"
									:disabled="!!nh.busy"
									autocomplete="off" /></label
							><label
								>APNS Team ID<Input
									v-model="fields.teamId"
									maxlength="10"
									:disabled="!!nh.busy"
									autocomplete="off" /></label
							><label
								>APNS Bundle ID<Input
									v-model="fields.bundleId"
									maxlength="255"
									:disabled="!!nh.busy"
									autocomplete="off"
							/></label>
						</div>
						<template v-if="importing"
							><label v-if="provider.endsWith('certificate')"
								>Certificate password (leave empty if none)<Input
									v-model="password"
									type="password"
									maxlength="1024"
									autocomplete="off"
									:disabled="!!nh.busy" /></label
							><Button variant="outline" :disabled="!!nh.busy" @click="importFile"
								>Import credential file…</Button
							>
							<p v-if="artifact" role="status">
								{{ artifact.summary }} Import expires
								{{ new Date(artifact.expiresAt).toLocaleString() }}.
							</p>
							<p class="field-hint">
								Up to 256 KiB. Files are validated locally before any Azure write.
								Private keys and passwords remain in memory only; closing this
								editor discards its import.
							</p></template
						>
						<div v-if="provider === 'wns'" class="provider-fields">
							<label
								>WNS Package SID<Input
									v-model="fields.packageSid"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy" /></label
							><label
								>WNS client secret<Input
									v-model="fields.secretKey"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
						</div>
						<div v-if="provider === 'adm'" class="provider-fields">
							<label
								>ADM client ID<Input
									v-model="fields.clientId"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy" /></label
							><label
								>ADM client secret<Input
									v-model="fields.clientSecret"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
						</div>
						<div v-if="provider === 'baidu'" class="provider-fields">
							<label
								>Baidu API key<Input
									v-model="fields.apiKey"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy" /></label
							><label
								>Baidu secret key<Input
									v-model="fields.secretKey"
									type="password"
									maxlength="8192"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
						</div>
						<div v-if="provider === 'browser'" class="provider-fields">
							<label
								>VAPID contact subject<Input
									v-model="fields.subject"
									aria-label="VAPID contact subject"
									placeholder="mailto:push@example.com"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
							<label
								>VAPID public key<Input
									v-model="fields.vapidPublicKey"
									aria-label="VAPID public key"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
							<label
								>VAPID private key<Input
									v-model="fields.vapidPrivateKey"
									aria-label="VAPID private key"
									type="password"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
							<p class="field-hint">
								Use an existing P-256 VAPID key pair in unpadded base64url. Matching
								keys are validated locally. Changing the key pair can require
								browsers to subscribe again.
							</p>
						</div>
						<div v-if="provider === 'xiaomi'" class="provider-fields">
							<label
								>Xiaomi app secret<Input
									v-model="fields.appSecret"
									aria-label="Xiaomi app secret"
									type="password"
									autocomplete="off"
									:disabled="!!nh.busy"
							/></label>
							<label
								>Xiaomi regional endpoint<Input
									v-model="fields.endpoint"
									aria-label="Xiaomi regional endpoint"
									:disabled="!!nh.busy"
							/></label>
							<p class="field-hint">
								Azure exposes Xiaomi configuration. Provider availability and
								regional delivery require live qualification. The desktop saves
								these settings through Azure and does not call this endpoint.
							</p>
						</div>
					</template>
					<p v-if="nh.error || error" role="alert" class="form-error">
						{{ error || nh.error }}
					</p>
					<p v-if="status && !valid.success" class="field-hint">
						{{
							importing && !artifact
								? 'Import a credential file before saving.'
								: provider === 'apns-token'
									? 'Enter a 10-character Key ID and Team ID, and the app Bundle ID.'
									: 'Enter the required provider credentials.'
						}}
					</p>
					<label class="provider-confirm"
						><input
							v-model="acknowledged"
							type="checkbox"
							:disabled="!!nh.busy || !status || !valid.success"
						/>I reviewed this hub, provider and environment and understand this
						{{ remove ? 'removes' : 'replaces' }} its provider credentials.</label
					>
				</template>
			</div>
			<footer class="provider-footer">
				<Button v-if="nh.busy" variant="outline" @click="nh.cancel()"
					>Cancel provider operation</Button
				><template v-else
					><Button variant="outline" @click="close">{{
						result ? 'Close provider result' : 'Close provider credentials'
					}}</Button
					><Button v-if="!result" variant="outline" @click="load"
						>Refresh provider status</Button
					><Button
						v-if="!result"
						:variant="remove ? 'destructive' : 'default'"
						:disabled="
							nh.blocked ||
							!status ||
							!valid.success ||
							!acknowledged ||
							(remove && !status.configured)
						"
						@click="save"
						>{{
							remove ? 'Remove provider credentials' : 'Save provider credentials'
						}}</Button
					></template
				>
			</footer>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.provider-dialog {
	display: flex;
	flex-direction: column;
	max-height: 85vh;
	overflow: hidden;
}
.provider-body {
	display: flex;
	flex-direction: column;
	gap: 14px;
	overflow: auto;
	min-height: 0;
}
.provider-body label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 13px;
}
.provider-body select {
	padding: 8px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	color: inherit;
}
.provider-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	gap: 12px;
}
.provider-fields > p {
	grid-column: 1 / -1;
}
.provider-body .provider-confirm {
	flex-direction: row;
	align-items: flex-start;
}
.provider-confirm input {
	margin-top: 3px;
}
.provider-footer {
	display: flex;
	flex-wrap: wrap;
	justify-content: flex-end;
	gap: 8px;
	padding-top: 14px;
	border-top: 1px solid var(--border);
	flex-shrink: 0;
}
</style>
