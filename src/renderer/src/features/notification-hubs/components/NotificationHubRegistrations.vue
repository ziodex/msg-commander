<script setup lang="ts">
import { notificationHubsApi } from '@/features/notification-hubs/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useNotificationHubRegistrations } from '@/features/notification-hubs/stores/notification-hub-registrations'
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import { useWorkspace } from '@/shared/workspace/store'
import type { Profile } from '@shared/contracts'
import type {
	NotificationHubPage,
	NotificationHubTarget,
} from '@shared/contracts/notification-hubs/core'
import {
	defaultRegistrationQuery,
	nhRegistrationQuerySchema,
	nhRegistrationsConnectSchema,
} from '@shared/contracts/notification-hubs/registrations'
import NotificationHubRegistrationEditor from './NotificationHubRegistrationEditor.vue'
import NotificationHubRegistrationInspector from './NotificationHubRegistrationInspector.vue'
import NotificationHubRegistrationFiles from './NotificationHubRegistrationFiles.vue'
import NotificationHubJobs from './NotificationHubJobs.vue'
const props = defineProps<{ profile: Profile; initialHub: string }>(),
	emit = defineEmits<{ back: [] }>()
const registrations = useNotificationHubRegistrations(),
	nh = useNotificationHubs(),
	workspace = useWorkspace()
const hubName = ref(props.initialHub || registrations.connection?.hubName || ''),
	source = ref<'profile' | 'policy'>(props.profile.auth === 'sas' ? 'profile' : 'policy')
const policyScope = ref<'hub' | 'namespace'>('namespace'),
	policies = ref<NotificationHubPage>({ items: [], continuationToken: null }),
	selectedPolicy = ref(''),
	keyType = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey')
const query = ref(defaultRegistrationQuery()),
	formError = ref('')
const connected = computed(
	() =>
		registrations.connection?.profileId === props.profile.id &&
		registrations.connection.hubName === hubName.value,
)
const management = computed(() =>
	nh.connection?.profileId === props.profile.id ? nh.connection : undefined,
)
const pending = computed(() => !!registrations.busy || !!nh.busy)
const dirty = computed(() => JSON.stringify(query.value) !== JSON.stringify(registrations.query))
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
const selectedSnapshots = ref<string[]>([]),
	jobsDialog = ref(false),
	fileDialog = ref(false),
	fileTab = ref<'import' | 'export' | 'results'>('import'),
	exportSnapshots = ref<string[]>([])
watch(
	() => registrations.page,
	() => {
		selectedSnapshots.value = []
	},
)
watch(
	() => registrations.connection?.connectionId,
	() => {
		fileDialog.value = false
		jobsDialog.value = false
		selectedSnapshots.value = []
	},
)
function openFiles(tab: 'import' | 'export' | 'results', snapshots = selectedSnapshots.value) {
	exportSnapshots.value = [...snapshots]
	fileTab.value = tab
	fileDialog.value = true
}
function exportInspection() {
	const snapshot = registrations.details?.registration.snapshotId
	registrations.details = undefined
	if (snapshot) openFiles('export', [snapshot])
}
let epoch = 0
watch([hubName, policyScope, source, () => nh.connection?.connectionId], () => {
	epoch++
	policies.value = { items: [], continuationToken: null }
	selectedPolicy.value = ''
	formError.value = ''
})
watch(
	() => registrations.query,
	(value) => {
		query.value = { ...value }
	},
	{ immediate: true },
)
watch(
	() => query.value.mode,
	() => {
		query.value.value = ''
		query.value.handleKind = 'any'
		formError.value = ''
	},
)
watch(
	() => registrations.connection?.connectionId,
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
	await registrations.task(
		'List registration access policies',
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
			'Enter a hub name and select a Manage policy from this hub or its namespace, or use the saved SAS profile.'
		return
	}
	formError.value = ''
	await registrations.connect(setup)
}
async function search() {
	const parsed = nhRegistrationQuerySchema.safeParse(query.value)
	if (!parsed.success) {
		formError.value = parsed.error.issues[0].message
		return
	}
	formError.value = ''
	await registrations.search(parsed.data)
}
function back() {
	registrations.details = undefined
	emit('back')
}
</script>
<template>
	<section class="nh-registrations" aria-label="Notification Hubs registrations">
		<div class="nh-heading">
			<div>
				<div class="eyebrow">Notification Hubs</div>
				<h2>Registrations</h2>
				<p class="field-hint">Browse registrations by page, exact tag or device handle.</p>
			</div>
			<Button variant="outline" size="sm" :disabled="pending" @click="back"
				>Back to administration</Button
			>
		</div>
		<form v-if="!connected" class="nh-registration-setup nh-form" @submit.prevent="connect">
			<label
				>Registration hub name<Input
					v-model="hubName"
					:disabled="pending"
					placeholder="my-hub"
			/></label>
			<label
				>Registration credential<select
					aria-label="Registration credential"
					v-model="source"
					:disabled="pending"
				>
					<option v-if="profile.auth === 'sas'" value="profile">Saved SAS profile</option>
					<option value="policy">Select a Manage policy through Entra</option>
				</select></label
			>
			<p v-if="source === 'profile'" class="field-hint">
				Connect uses the saved SAS key for this hub. A hub-scoped connection string must
				match the hub name. Registration enumeration requires Manage rights.
			</p>
			<template v-else>
				<p v-if="!management" class="form-warning">
					Connect Notification Hubs management first, then select a Manage policy
					explicitly.
				</p>
				<template v-else
					><div class="nh-fields">
						<label
							>Policy scope<select
								aria-label="Registration policy scope"
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
							>Manage policy<select
								aria-label="Registration Manage policy"
								v-model="selectedPolicy"
								:disabled="pending"
							>
								<option value="" disabled>Select a policy</option>
								<option
									v-for="item in policies.items"
									:key="item.target.policyName!"
									:value="item.target.policyName!"
									:disabled="!item.rights?.includes('Manage')"
								>
									{{ item.target.policyName }} · {{ item.rights?.join(', ') }}
								</option>
							</select></label
						><label
							>Registration key slot<select
								aria-label="Registration key slot"
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
				>Connect registrations</Button
			>
		</form>
		<template v-else>
			<div class="nh-toolbar">
				<span class="nh-connected"
					><span class="status-dot ready" />Registrations connected ·
					{{ registrations.connection?.hubName }}</span
				><span class="field-hint">{{ profile.namespace }} · SAS data access</span
				><Button
					variant="ghost"
					size="sm"
					:disabled="pending"
					@click="registrations.disconnect()"
					>Disconnect registrations</Button
				>
			</div>
			<div class="nh-actions">
				<Button variant="outline" :disabled="pending" @click="jobsDialog = true"
					>Azure Storage jobs…</Button
				>
				<Button
					:disabled="registrations.blocked"
					@click="registrations.openEditor('create')"
					>Create registration…</Button
				>
				<Button variant="outline" :disabled="pending" @click="openFiles('import')"
					>Import registrations…</Button
				>
				<Button
					variant="outline"
					:disabled="pending || !selectedSnapshots.length"
					@click="openFiles('export')"
					>Export selected registrations…</Button
				>
				<Button
					variant="ghost"
					:disabled="pending || !registrations.page?.items.length"
					@click="
						openFiles(
							'export',
							registrations.page!.items.map((i) => i.snapshotId),
						)
					"
					>Export current page…</Button
				>
				<Button
					v-if="registrations.fileOutcome"
					variant="outline"
					:disabled="pending"
					@click="openFiles('results')"
					>Registration import results…</Button
				>
			</div>
			<p v-if="registrations.fileOutcome" class="nh-registration-receipt" role="status">
				{{ registrations.fileOutcome.summary }}
			</p>
			<section
				v-if="registrations.outcome"
				class="nh-registration-receipt"
				aria-label="Registration change receipt"
			>
				<strong>{{ registrations.outcome.status }}</strong> ·
				{{ registrations.outcome.summary }}
				<p>Registration ID: {{ registrations.outcome.registrationId ?? 'Unknown' }}</p>
				<p class="field-hint">Receipt {{ registrations.outcome.operationId }}</p>
				<Button
					v-if="registrations.outcome.status === 'unknown'"
					variant="outline"
					size="sm"
					:disabled="pending"
					@click="registrations.recover()"
					>Check registration receipt</Button
				><label v-if="registrations.outcome.status === 'unknown'" class="nh-check"
					><input type="checkbox" v-model="registrations.reviewed" :disabled="pending" />I
					checked Azure state and reviewed the uncertain registration outcome.</label
				>
			</section>
			<form class="nh-registration-query" @submit.prevent="search">
				<label
					>Registration query<select
						aria-label="Registration query"
						v-model="query.mode"
						:disabled="pending"
					>
						<option value="all">All registrations</option>
						<option value="tag">Exact tag</option>
						<option value="handle">Device handle</option>
					</select></label
				>
				<label v-if="query.mode === 'tag'"
					>Registration tag<Input
						v-model="query.value"
						:disabled="pending"
						placeholder="customer:123"
				/></label>
				<template v-if="query.mode === 'handle'"
					><label
						>Handle format<select
							aria-label="Registration handle format"
							v-model="query.handleKind"
							:disabled="pending"
						>
							<option value="any">Any PNS handle</option>
							<option value="apns">APNS device token (hex)</option>
							<option value="wns">WNS channel URI (HTTPS)</option>
							<option value="fcm">FCM registration token</option>
						</select></label
					><label class="nh-handle-input"
						>Device handle<Input v-model="query.value" :disabled="pending" /></label
				></template>
				<label
					>Registrations per page<select
						aria-label="Registrations per page"
						v-model.number="query.pageSize"
						:disabled="pending"
					>
						<option :value="10">10</option>
						<option :value="25">25</option>
						<option :value="50">50</option>
						<option :value="100">100</option>
					</select></label
				><Button type="submit" :disabled="pending">{{
					registrations.page ? 'Apply query / refresh' : 'Load registrations'
				}}</Button>
			</form>
			<p v-if="dirty && registrations.page" class="field-hint">
				Apply the changed query before paging. The table still shows the last successful
				query.
			</p>
			<div v-if="registrations.page" class="nh-registration-results">
				<div class="nh-heading">
					<p role="status">
						Page {{ registrations.pageNumber }} ·
						{{ registrations.page.items.length }} registrations on this page{{
							registrations.page.continuationToken ? ' · more available' : ''
						}}
					</p>
					<span class="field-hint"
						>Captured
						{{ new Date(registrations.page.capturedAt).toLocaleTimeString() }} · live
						enumeration, not a total count</span
					>
				</div>
				<div class="nh-registration-table-wrap">
					<table class="nh-policy-table nh-registration-table">
						<thead>
							<tr>
								<th class="nh-registration-select">
									<input
										type="checkbox"
										aria-label="Select current registrations page"
										:checked="
											!!registrations.page.items.length &&
											selectedSnapshots.length ===
												registrations.page.items.length
										"
										:disabled="pending || !registrations.page.items.length"
										@change="
											selectedSnapshots = ($event.target as HTMLInputElement)
												.checked
												? registrations.page.items.map((i) => i.snapshotId)
												: []
										"
									/>
								</th>
								<th>Registration ID</th>
								<th>Platform</th>
								<th>Tags</th>
								<th>Device handle</th>
								<th>Expiration</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="item in registrations.page.items"
								:key="item.snapshotId"
								:aria-label="`Registration ${item.registrationId}`"
							>
								<td class="nh-registration-select">
									<input
										v-model="selectedSnapshots"
										type="checkbox"
										:value="item.snapshotId"
										:aria-label="`Select registration ${item.registrationId}`"
										:disabled="pending"
									/>
								</td>
								<td>{{ item.registrationId }}</td>
								<td>
									{{ item.platform
									}}<small>{{ item.template ? 'Template' : 'Native' }}</small>
								</td>
								<td>
									<span
										v-for="tag in item.tags.slice(0, 3)"
										:key="tag"
										class="nh-registration-tag"
										>{{ tag }}</span
									><small v-if="item.tags.length > 3"
										>+{{ item.tags.length - 3 }} tags</small
									>
								</td>
								<td class="nh-registration-handle" :title="item.handle ?? ''">
									{{ item.handle ?? 'See XML' }}
								</td>
								<td>{{ item.expirationTime ?? 'Not supplied' }}</td>
								<td>
									<Button
										size="sm"
										variant="outline"
										:disabled="pending"
										@click="registrations.inspect(item.snapshotId)"
										>Inspect</Button
									>
									<Button
										size="sm"
										variant="ghost"
										:disabled="registrations.blocked"
										@click="registrations.openEditor('update', item.snapshotId)"
										>Edit</Button
									>
									<Button
										size="sm"
										variant="ghost"
										:disabled="registrations.blocked"
										@click="registrations.openEditor('delete', item.snapshotId)"
										>Delete</Button
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p v-if="!registrations.page.items.length" class="field-hint">
					No registrations on this page.{{
						registrations.page.continuationToken
							? ' Continue to the next page.'
							: ' No more results for this query.'
					}}
				</p>
				<div class="nh-actions nh-registration-pagination">
					<Button
						variant="outline"
						size="sm"
						:disabled="pending || dirty || registrations.pageNumber < 2"
						@click="registrations.previous()"
						>Previous registrations page</Button
					><Button
						variant="outline"
						size="sm"
						:disabled="pending || dirty || !registrations.page.continuationToken"
						@click="registrations.next()"
						>Next registrations page</Button
					>
				</div>
				<p class="field-hint">
					Previous pages are fetched again. Registrations may change during enumeration;
					refresh starts a new query.
				</p>
			</div>
		</template>
		<p v-if="formError || registrations.error" class="form-error" role="alert">
			{{ formError || registrations.error }}
		</p>
		<div v-if="registrations.busy" class="nh-working" role="status">
			{{ registrations.busy }}…<Button
				variant="outline"
				size="sm"
				@click="registrations.cancel()"
				>Cancel registration operation</Button
			>
		</div>
		<NotificationHubRegistrationFiles
			v-if="fileDialog && connected"
			:snapshot-ids="exportSnapshots"
			:initial-tab="fileTab"
			@close="fileDialog = false"
		/>
		<NotificationHubJobs v-if="jobsDialog && connected" @close="jobsDialog = false" />
		<NotificationHubRegistrationEditor v-if="registrations.editor && connected" />
		<NotificationHubRegistrationInspector
			v-if="registrations.details && connected"
			:details="registrations.details"
			:busy="pending"
			:blocked="registrations.blocked"
			@edit="
				registrations.openEditor('update', registrations.details!.registration.snapshotId)
			"
			@delete="
				registrations.openEditor('delete', registrations.details!.registration.snapshotId)
			"
			@refresh="registrations.refreshInspection()"
			@export="exportInspection"
			@close="registrations.details = undefined"
		/>
	</section>
</template>
<style>
.nh-registrations {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-width: 0;
}
.nh-registration-setup {
	max-width: 800px;
	padding: 20px;
	border: 1px solid var(--border);
	border-radius: 12px;
	background: var(--card);
}
.nh-registration-query {
	display: flex;
	align-items: end;
	flex-wrap: wrap;
	gap: 12px;
	padding: 16px;
	background: var(--card);
	border: 1px solid var(--border);
	border-radius: 10px;
}
.nh-registration-query label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.nh-handle-input {
	flex: 1;
	min-width: 240px;
}
.nh-registration-table-wrap {
	overflow: auto;
}
.nh-registration-table {
	min-width: 850px;
	table-layout: fixed;
}
.nh-registration-table th:nth-child(2) {
	width: 18%;
}
.nh-registration-table th:nth-child(3) {
	width: 13%;
}
.nh-registration-table th:nth-child(4) {
	width: 18%;
}
.nh-registration-table th:nth-child(5) {
	width: 22%;
}
.nh-registration-table th:last-child {
	width: 180px;
}
.nh-registration-table .nh-registration-select {
	width: 38px;
}
.nh-registration-table td {
	overflow-wrap: anywhere;
}
.nh-registration-table small {
	display: block;
	color: var(--muted-foreground);
	margin-top: 3px;
}
.nh-registration-handle {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--font-mono);
}
.nh-registration-tag {
	display: inline-block;
	padding: 2px 5px;
	margin: 2px;
	background: var(--muted);
	border-radius: 4px;
	font-size: 11px;
}
.nh-registration-pagination {
	justify-content: flex-end;
	margin: 14px 0;
}
.nh-registration-properties {
	display: grid;
	grid-template-columns: 130px minmax(0, 1fr);
	gap: 8px 14px;
	font-size: 13px;
}
.nh-registration-properties dt {
	color: var(--muted-foreground);
}
.nh-registration-properties dd {
	overflow-wrap: anywhere;
}
.nh-device-handle {
	font-family: var(--font-mono);
}
.nh-registration-inspector {
	max-height: 85vh;
	overflow-y: auto;
}
.nh-registration-inspector summary {
	cursor: pointer;
	margin-bottom: 10px;
}
.nh-registration-xml {
	max-height: 360px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
</style>
