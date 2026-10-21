<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Bell, Network, RefreshCw, Plus, ChevronDown, ChevronRight } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import NotificationHubNotifications from './NotificationHubNotifications.vue'
import NotificationHubRegistrations from './NotificationHubRegistrations.vue'
import NotificationHubsMenu from './NotificationHubsMenu.vue'
import NotificationHubsEditor from './NotificationHubsEditor.vue'
import NotificationHubsKeys from './NotificationHubsKeys.vue'
import NotificationHubCredentials from './NotificationHubCredentials.vue'
import NotificationHubConfiguration from './NotificationHubConfiguration.vue'
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import { useWorkspace } from '@/shared/workspace/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import type { Profile } from '@shared/contracts'
import {
	nhConnectSchema,
	nhNamespace,
	type NotificationHubScope,
	type NotificationHubTarget,
	type NotificationHubChange,
} from '@shared/contracts/notification-hubs/core'
const props = defineProps<{ profile: Profile }>(),
	emit = defineEmits<{ settings: []; remove: [] }>()
const nh = useNotificationHubs(),
	workspace = useWorkspace(),
	layout = useWorkspaceLayout()
const management = reactive({ resourceId: '', tenantId: '', clientId: '' }),
	formError = ref('')
const sender = ref(false),
	senderHub = ref('')
function testSend(name = '') {
	senderHub.value = name
	sender.value = true
}
const browser = ref(false),
	browserHub = ref('')
function browse(name = '') {
	browserHub.value = name
	browser.value = true
}
const expanded = ref(true),
	editor = ref<{ target: NotificationHubTarget; action: NotificationHubChange['action'] }>(),
	keys = ref<NotificationHubTarget>()
const configScope = ref<NotificationHubScope>()
const credentialTarget = ref<NotificationHubTarget>()
const connected = computed(() => nh.connection?.profileId === props.profile.id)
const propertyLabels: Record<string, string> = {
	registrationTtl: 'Registration lifetime',
	dailyMaxActiveDevices: 'Daily maximum active devices',
	provisioningState: 'Provisioning state',
	serviceBusEndpoint: 'Namespace endpoint',
	createdAt: 'Created',
	updatedAt: 'Updated',
	publicNetworkAccess: 'Public network access',
}
const target = (scope = nh.selected, policyName: string | null = null): NotificationHubTarget => ({
	scope: { ...scope },
	policyName,
})
watch(
	() => props.profile,
	(profile) => {
		browser.value = false
		sender.value = false
		management.tenantId = profile.tenantId
		management.clientId = profile.clientId
		management.resourceId = ''
		formError.value = ''
		editor.value = undefined
		keys.value = undefined
		credentialTarget.value = undefined
		configScope.value = undefined
	},
	{ immediate: true },
)
watch(
	() => nh.connection?.connectionId,
	() => {
		editor.value = undefined
		keys.value = undefined
		credentialTarget.value = undefined
		configScope.value = undefined
	},
)
async function connect() {
	if (
		!nhConnectSchema.safeParse({
			id: crypto.randomUUID(),
			profileId: props.profile.id,
			management: { ...management },
		}).success
	) {
		formError.value =
			'Enter the Notification Hubs namespace resource ID, Entra tenant and public client application ID.'
		return
	}
	formError.value = ''
	await nh.connect({ profileId: props.profile.id, management: { ...management } })
}
function create() {
	editor.value = {
		action: 'create',
		target: { scope: { kind: 'hub', name: 'new-hub' }, policyName: null },
	}
}
async function action(name: string, scope: NotificationHubScope) {
	if (name === 'configuration') configScope.value = { ...scope }
	else if (name === 'credentials') credentialTarget.value = target(scope)
	else if (name === 'notifications') testSend(scope.name)
	else if (name === 'registrations') browse(scope.name)
	else if (name === 'create') create()
	else if (name === 'edit' || name === 'delete')
		editor.value = { action: name === 'edit' ? 'update' : 'delete', target: target(scope) }
	else if (name === 'refresh' && scope.kind === 'namespace') await nh.refresh()
	else await nh.select(scope)
}
</script>
<template>
	<section class="nh-explorer" aria-label="Notification Hubs explorer">
		<NotificationHubNotifications
			v-if="sender"
			:profile="profile"
			:initial-hub="senderHub"
			@back="sender = false"
		/>
		<NotificationHubRegistrations
			v-else-if="browser"
			:profile="profile"
			:initial-hub="browserHub"
			@back="browser = false"
		/>
		<template v-else>
			<div class="nh-actions">
				<Button
					variant="outline"
					size="sm"
					:disabled="!!nh.busy"
					@click="testSend(nh.selected.kind === 'hub' ? nh.selected.name : '')"
					>Test notifications…</Button
				>
				<Button
					variant="outline"
					size="sm"
					:disabled="!!nh.busy"
					@click="browse(nh.selected.name)"
					>Browse registrations…</Button
				>
			</div>
			<div v-if="!connected" class="nh-connect">
				<div class="nh-heading">
					<Bell :size="25" />
					<div>
						<h2>Connect to Notification Hubs management</h2>
						<p>Browse hubs and manage settings, SAS policies and keys.</p>
					</div>
				</div>
				<p class="field-hint">
					Administration uses Microsoft Entra permissions on the Notification Hubs
					namespace. The profile's SAS data credential is not needed or unlocked.
				</p>
				<form class="nh-form" @submit.prevent="connect">
					<label
						>Notification Hubs namespace resource ID<Input
							v-model="management.resourceId"
							placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.NotificationHubs/namespaces/…"
					/></label>
					<div class="nh-fields">
						<label
							>Notification Hubs management tenant<Input
								v-model="management.tenantId" /></label
						><label
							>Notification Hubs public client application ID<Input
								v-model="management.clientId"
						/></label>
					</div>
					<p class="field-hint">
						Use a public client application with device-code sign-in enabled. Resource
						read access allows browsing; changes and keys require their respective ARM
						permissions.
					</p>
					<p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
					<div class="nh-actions">
						<Button type="submit" :disabled="!workspace.ready || !!nh.busy"
							>Connect Notification Hubs</Button
						><Button
							type="button"
							variant="outline"
							:disabled="!!nh.busy"
							@click="emit('settings')"
							>Connection settings</Button
						><Button
							type="button"
							variant="ghost"
							:disabled="!!nh.busy"
							@click="emit('remove')"
							>Remove profile</Button
						>
					</div>
				</form>
			</div>
			<template v-else>
				<div class="nh-toolbar">
					<span class="nh-connected"
						><span class="status-dot ready" />Notification Hubs connected</span
					><Button
						variant="outline"
						size="sm"
						:disabled="!!nh.busy"
						@click="configScope = { ...nh.selected }"
						>Configuration files…</Button
					><span class="field-hint"
						>{{ nh.connection?.location }} · Management access</span
					>
					<div class="nh-actions">
						<Button
							variant="outline"
							size="sm"
							:disabled="!!nh.busy"
							@click="nh.refresh()"
							><RefreshCw :size="14" />Refresh namespace</Button
						><Button
							variant="ghost"
							size="sm"
							:disabled="!!nh.busy"
							@click="nh.disconnect()"
							>Disconnect Notification Hubs</Button
						>
					</div>
				</div>
				<div v-if="nh.configOutcome" class="relay-receipt" role="status">
					<strong>Last configuration import · {{ nh.configOutcome.status }}</strong>
					<p>{{ nh.configOutcome.summary }}</p>
					<Button
						variant="outline"
						size="sm"
						:disabled="!!nh.busy"
						@click="configScope = { ...nh.selected }"
						>View import results</Button
					>
				</div>
				<div class="nh-layout" :class="{ 'tree-hidden': !layout.treeVisible }">
					<nav
						v-if="layout.treeVisible"
						class="nh-tree"
						aria-label="Notification Hubs resources"
					>
						<div class="nh-tree-tools">
							<strong>RESOURCES</strong
							><Button variant="ghost" size="sm" @click="expanded = !expanded">{{
								expanded ? 'Collapse all' : 'Expand all'
							}}</Button>
						</div>
						<NotificationHubsMenu :scope="nhNamespace" @action="action"
							><button
								class="nh-node namespace"
								:class="{ selected: nh.selected.kind === 'namespace' }"
								:disabled="!!nh.busy"
								@click="nh.select(nhNamespace)"
							>
								<Network :size="16" /><span>{{ profile.namespace }}</span>
							</button></NotificationHubsMenu
						>
						<button
							class="nh-group"
							:aria-expanded="expanded"
							@click="expanded = !expanded"
						>
							<ChevronDown v-if="expanded" :size="15" /><ChevronRight
								v-else
								:size="15"
							/>Notification Hubs<span
								>{{ nh.hubs.items.length
								}}{{ nh.hubs.continuationToken ? '+' : '' }}</span
							>
						</button>
						<div v-if="expanded" class="nh-branch">
							<NotificationHubsMenu
								v-for="item in nh.hubs.items"
								:key="item.target.scope.name"
								:scope="item.target.scope"
								@action="action"
								><button
									class="nh-node"
									:aria-label="`Notification Hub ${item.target.scope.name}`"
									:class="{
										selected:
											nh.selected.kind === 'hub' &&
											nh.selected.name === item.target.scope.name,
									}"
									:disabled="!!nh.busy"
									@click="nh.select(item.target.scope)"
								>
									<Bell :size="14" /><span>{{ item.target.scope.name }}</span>
								</button></NotificationHubsMenu
							>
							<p v-if="!nh.hubs.items.length" class="field-hint">No hubs loaded.</p>
							<Button
								v-if="nh.hubs.continuationToken"
								variant="ghost"
								size="sm"
								:disabled="!!nh.busy"
								@click="nh.list(true)"
								>Load more hubs</Button
							>
						</div>
					</nav>
					<div class="nh-content">
						<div class="nh-heading">
							<div>
								<div class="eyebrow">
									{{
										nh.selected.kind === 'namespace'
											? 'Namespace'
											: 'Notification Hub'
									}}
								</div>
								<h2>{{ nh.selected.name || profile.namespace }}</h2>
							</div>
							<div class="nh-actions">
								<Button
									v-if="nh.selected.kind === 'namespace'"
									size="sm"
									:disabled="nh.blocked"
									@click="create"
									><Plus :size="14" />Create Notification Hub</Button
								><template v-else
									><Button
										size="sm"
										variant="outline"
										:disabled="nh.blocked || !nh.details?.settings"
										@click="editor = { action: 'update', target: target() }"
										>Edit hub</Button
									><Button
										size="sm"
										variant="outline"
										:disabled="nh.blocked"
										@click="credentialTarget = target()"
										>Provider credentials…</Button
									><Button
										size="sm"
										variant="destructive"
										:disabled="nh.blocked || !nh.details"
										@click="editor = { action: 'delete', target: target() }"
										>Delete hub</Button
									></template
								>
							</div>
						</div>
						<p class="field-hint">
							Edit registration lifetime and Azure tags. Existing push-provider
							configuration is preserved.
						</p>
						<div v-if="nh.details" class="nh-properties">
							<h3>Properties</h3>
							<p v-if="nh.details.warning" class="form-warning">
								{{ nh.details.warning }}
							</p>
							<dl>
								<template
									v-for="property in nh.details.properties"
									:key="property.name"
									><dt>{{ propertyLabels[property.name] ?? property.name }}</dt>
									<dd>
										{{
											property.name === 'registrationTtl' &&
											property.value === '10675199.02:48:05.4775807'
												? 'No expiry (maximum lifetime)'
												: property.value
										}}
									</dd></template
								>
							</dl>
							<dl v-if="nh.details.settings?.tags.length" aria-label="Azure tags">
								<template v-for="tag in nh.details.settings.tags" :key="tag.name"
									><dt>{{ tag.name }}</dt>
									<dd>{{ tag.value }}</dd></template
								>
							</dl>
						</div>
						<div class="nh-policies">
							<div class="nh-heading">
								<h3>SAS policies</h3>
								<div class="nh-actions">
									<Button
										size="sm"
										variant="ghost"
										:disabled="!!nh.busy"
										@click="nh.listPolicies()"
										>Refresh policies</Button
									><Button
										size="sm"
										variant="outline"
										:disabled="nh.blocked || !nh.details"
										@click="
											editor = {
												action: 'create',
												target: target(nh.selected, 'new-policy'),
											}
										"
										>Create SAS policy</Button
									>
								</div>
							</div>
							<p class="field-hint">
								Policies grant access to {{ nh.selected.name || 'the namespace' }}.
								Keys stay hidden until requested.
							</p>
							<table v-if="nh.policies.items.length" class="nh-policy-table">
								<thead>
									<tr>
										<th>Policy</th>
										<th>Rights</th>
										<th>Actions</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="item in nh.policies.items"
										:key="item.target.policyName!"
										:aria-label="`Policy ${item.target.policyName}`"
									>
										<td>{{ item.target.policyName }}</td>
										<td>{{ item.rights?.join(', ') }}</td>
										<td>
											<div class="nh-actions">
												<Button
													size="sm"
													variant="ghost"
													:disabled="nh.blocked"
													@click="
														editor = {
															action: 'update',
															target: item.target,
														}
													"
													>Edit</Button
												><Button
													size="sm"
													variant="ghost"
													:disabled="!!nh.busy"
													@click="keys = item.target"
													>Keys</Button
												><Button
													size="sm"
													variant="ghost"
													:disabled="nh.blocked"
													@click="
														editor = {
															action: 'regenerate',
															target: item.target,
														}
													"
													>Regenerate</Button
												><Button
													size="sm"
													variant="ghost"
													:disabled="
														nh.blocked ||
														(nh.selected.kind === 'namespace' &&
															item.target.policyName?.toLowerCase() ===
																'rootmanagesharedaccesskey')
													"
													@click="
														editor = {
															action: 'delete',
															target: item.target,
														}
													"
													>Delete</Button
												>
											</div>
										</td>
									</tr>
								</tbody>
							</table>
							<p v-else class="field-hint">No policies loaded.</p>
							<Button
								v-if="nh.policies.continuationToken"
								variant="outline"
								size="sm"
								:disabled="!!nh.busy"
								@click="nh.listPolicies(true)"
								>Load more policies</Button
							>
						</div>
					</div>
				</div>
				<div v-if="nh.outcome" class="nh-receipt" role="status">
					<strong>Last Notification Hubs change · {{ nh.outcome.status }}</strong>
					<p>{{ nh.outcome.summary }}</p>
					<small>Receipt: {{ nh.outcome.operationId }}</small
					><template v-if="nh.outcome.status === 'unknown'"
						><Button
							variant="outline"
							size="sm"
							:disabled="!!nh.busy"
							@click="nh.recover()"
							>Check retained receipt</Button
						><label class="checkbox-label"
							><input v-model="nh.reviewed" type="checkbox" :disabled="!!nh.busy" />I
							checked Azure state and reviewed the uncertain outcome before another
							change.</label
						></template
					>
				</div>
			</template>
			<div v-if="nh.busy" class="nh-working" role="status">
				{{ nh.busy }}…<Button size="sm" variant="outline" @click="nh.cancel()"
					>Cancel Notification Hubs operation</Button
				>
			</div>
			<p v-if="nh.error" class="form-error" role="alert">{{ nh.error }}</p>
			<NotificationHubsEditor
				v-if="editor && connected"
				:key="`${editor.action}:${editor.target.scope.name}:${editor.target.policyName}`"
				:target="editor.target"
				:action="editor.action"
				@close="editor = undefined"
			/>
			<NotificationHubConfiguration
				v-if="configScope && connected"
				:scope="configScope"
				@close="configScope = undefined"
			/>
			<NotificationHubCredentials
				v-if="credentialTarget && connected"
				:target="credentialTarget"
				@close="credentialTarget = undefined"
			/>
			<NotificationHubsKeys
				v-if="keys && connected"
				:target="keys"
				@close="keys = undefined"
			/>
		</template>
	</section>
</template>
<style>
.nh-explorer {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-height: 0;
	flex: 1;
}
.nh-connect {
	max-width: 800px;
	padding: 24px;
	border: 1px solid var(--border);
	border-radius: 12px;
	background: var(--card);
}
.nh-heading,
.nh-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	flex-wrap: wrap;
}
.nh-heading h2 {
	font-size: 20px;
	margin: 4px 0;
	overflow-wrap: anywhere;
}
.nh-heading p {
	color: var(--muted-foreground);
	font-size: 13px;
}
.nh-actions {
	display: flex;
	gap: 6px;
	align-items: center;
	flex-wrap: wrap;
}
.nh-form,
.nh-form fieldset {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
}
.nh-form {
	margin-top: 18px;
}
.nh-fields {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 14px;
}
.nh-form label,
.nh-dialog > label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
	font-weight: 500;
}
.nh-form label.checkbox-label {
	flex-direction: row;
	align-items: center;
}
.nh-form textarea,
.nh-dialog textarea,
.nh-dialog select {
	width: 100%;
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	background: var(--background);
	color: var(--foreground);
	font-size: 13px;
}
.nh-dialog {
	max-height: 85vh;
	overflow: auto;
}
.nh-dialog textarea {
	font-family: var(--font-mono, monospace);
	overflow-wrap: anywhere;
}
.nh-toolbar {
	padding: 10px 14px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--card);
}
.nh-connected {
	display: flex;
	gap: 8px;
	align-items: center;
	font-size: 13px;
	font-weight: 600;
}
.nh-layout {
	display: grid;
	grid-template-columns: minmax(220px, 28%) minmax(0, 1fr);
	border: 1px solid var(--border);
	border-radius: 10px;
	overflow: hidden;
	flex: 1;
	min-height: 300px;
	background: var(--card);
}
.nh-layout.tree-hidden {
	grid-template-columns: minmax(0, 1fr);
}
.nh-tree {
	border-right: 1px solid var(--border);
	padding: 12px;
	overflow: auto;
	min-width: 0;
}
.nh-tree-tools {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 10px;
	color: var(--muted-foreground);
}
.nh-node,
.nh-group {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	text-align: left;
	border-radius: 5px;
	padding: 9px 7px;
	font-size: 12px;
	cursor: pointer;
}
.nh-node:hover,
.nh-group:hover {
	background: var(--muted);
}
.nh-node.selected {
	background: var(--accent);
	color: var(--accent-foreground);
}
.nh-node > span {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.nh-node > svg {
	flex-shrink: 0;
}
.nh-node small,
.nh-group > span {
	margin-left: auto;
	color: var(--muted-foreground);
}
.nh-node:disabled {
	opacity: 0.6;
}
.nh-node:focus-visible,
.nh-group:focus-visible {
	outline: 2px solid var(--ring);
	outline-offset: -2px;
}
.nh-group {
	margin-top: 10px;
	font-weight: 600;
}
.nh-branch {
	padding-left: 12px;
}
.nh-branch > p {
	padding: 10px;
}
.nh-content {
	padding: 20px;
	overflow: auto;
	min-width: 0;
}
.nh-content > p {
	margin: 8px 0;
}
.nh-properties,
.nh-policies {
	margin-top: 20px;
}
.nh-properties h3,
.nh-policies h3 {
	font-size: 13px;
	font-weight: 600;
}
.nh-properties dl {
	display: grid;
	grid-template-columns: minmax(120px, 30%) 1fr;
	font-size: 12px;
	gap: 8px 16px;
	padding: 12px 0;
}
.nh-properties dt {
	color: var(--muted-foreground);
}
.nh-properties dd {
	overflow-wrap: anywhere;
	min-width: 0;
}
.nh-policy-table {
	width: 100%;
	text-align: left;
	font-size: 12px;
	margin: 12px 0;
}
.nh-policy-table th {
	font-weight: 500;
	color: var(--muted-foreground);
	border-bottom: 1px solid var(--border);
	padding: 8px 4px;
}
.nh-policy-table td {
	padding: 8px 4px;
	border-bottom: 1px solid var(--border);
	overflow-wrap: anywhere;
}
.nh-receipt {
	border: 1px solid var(--border);
	background: var(--muted);
	border-radius: 8px;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.nh-receipt > button {
	align-self: flex-start;
}
.nh-working {
	display: flex;
	align-items: center;
	gap: 14px;
	font-size: 12px;
}
.nh-tag-row {
	display: grid;
	grid-template-columns: 1fr 1fr auto;
	gap: 8px;
	align-items: end;
}
</style>
