<script setup lang="ts">
import { relayApi } from '@/features/relay/api'

import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import { Network, Radio, RefreshCw, Plus, ChevronDown, ChevronRight } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import HybridTesting from './HybridTesting.vue'
import { useHybrid } from '@/features/relay/stores/hybrid'
import RelayMenu from './RelayMenu.vue'
import RelayEditor from './RelayEditor.vue'
import RelayKeys from './RelayKeys.vue'
import RelayConfiguration from './RelayConfiguration.vue'
import { useRelay } from '@/features/relay/stores/relay'
import { useWorkspace } from '@/shared/workspace/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import type { Profile } from '@shared/contracts'
import {
	relayConnectSchema,
	relayNamespace,
	type RelayScope,
	type RelayTarget,
	type RelayChange,
} from '@shared/contracts/relay/core'
const props = defineProps<{ profile: Profile }>(),
	emit = defineEmits<{ settings: []; remove: [] }>()
const hybrid = useHybrid(),
	testing = ref(false),
	testName = ref('')
const relay = useRelay(),
	workspace = useWorkspace(),
	layout = useWorkspaceLayout()
const management = reactive({ resourceId: '', tenantId: '', clientId: '' }),
	formError = ref(''),
	copied = ref('')
const expanded = reactive({ hybrid: true, wcf: true }),
	editor = ref<{ target: RelayTarget; action: RelayChange['action'] }>(),
	keys = ref<RelayTarget>(),
	configuration = ref<RelayScope>()
const connected = computed(() => relay.connection?.profileId === props.profile.id)
const propertyLabels: Record<string, string> = {
	listenerCount: 'Listeners',
	createdAt: 'Created',
	updatedAt: 'Updated',
	isDynamic: 'Dynamic resource',
	relayType: 'Relay type',
	requiresClientAuthorization: 'Client authorization required',
	requiresTransportSecurity: 'Transport security required',
	provisioningState: 'Provisioning state',
	serviceBusEndpoint: 'Namespace endpoint',
	publicNetworkAccess: 'Public network access',
	minimumTlsVersion: 'Minimum TLS version',
	userMetadata: 'Metadata',
}
const scopeLabel = (scope: RelayScope) =>
	scope.kind === 'namespace'
		? 'Namespace'
		: scope.kind === 'hybrid'
			? 'Hybrid Connection'
			: 'WCF Relay'
const target = (scope = relay.selected, policyName: string | null = null): RelayTarget => ({
	scope: { ...scope },
	policyName,
})
watch(
	() => props.profile,
	(profile) => {
		management.tenantId = profile.tenantId
		management.clientId = profile.clientId
		management.resourceId = ''
		formError.value = ''
		testing.value = false
		editor.value = undefined
		keys.value = undefined
		configuration.value = undefined
		copied.value = ''
	},
	{ immediate: true },
)
watch(
	() => relay.connection?.connectionId,
	() => {
		editor.value = undefined
		keys.value = undefined
		configuration.value = undefined
		copied.value = ''
	},
)
onBeforeUnmount(() => {
	keys.value = undefined
})
function showTesting() {
	testName.value = relay.selected.kind === 'hybrid' && connected.value ? relay.selected.name : ''
	testing.value = true
}
async function connect() {
	const parsed = relayConnectSchema.safeParse({
		id: crypto.randomUUID(),
		profileId: props.profile.id,
		management: { ...management },
	})
	if (!parsed.success) {
		formError.value =
			'Enter the Relay namespace resource ID, Entra tenant and public client application ID.'
		return
	}
	formError.value = ''
	await relay.connect({ profileId: props.profile.id, management: { ...management } })
}
async function copy(scope: RelayScope) {
	const value = await relay.run('Copy Relay endpoint', (id, connectionId) =>
		relayApi.copyRelayEndpoint({
			id,
			connectionId,
			target: target(scope),
			scheme: scope.kind === 'wcf' ? 'sb' : 'https',
		}),
	)
	if (value === null) copied.value = 'Endpoint copied.'
}
function create(kind: 'hybrid' | 'wcf') {
	editor.value = {
		action: 'create',
		target: { scope: { kind, name: 'new-resource' }, policyName: null },
	}
}
async function action(name: string, scope: RelayScope) {
	if (name === 'configuration') configuration.value = { ...scope }
	else if (name === 'test') {
		testName.value = scope.name
		testing.value = true
	} else if (name === 'create-hybrid') create('hybrid')
	else if (name === 'create-wcf') create('wcf')
	else if (name === 'edit' || name === 'delete')
		editor.value = { action: name === 'edit' ? 'update' : 'delete', target: target(scope) }
	else if (name === 'copy') await copy(scope)
	else if (name === 'refresh' && scope.kind === 'namespace') await relay.refresh()
	else await relay.select(scope)
}
</script>
<template>
	<section class="relay-explorer" aria-label="Relay explorer">
		<div class="relay-toolbar">
			<span class="field-hint"
				>HTTP and stream testing ·
				{{ hybrid.entries.filter((e) => e.running).length }} active jobs</span
			><Button variant="outline" size="sm" @click="showTesting"
				>Test Hybrid Connection…</Button
			>
		</div>
		<HybridTesting
			v-if="testing"
			:key="profile.id"
			:profile="profile"
			:name="testName"
			@close="testing = false"
		/>
		<template v-if="!connected"
			><div class="relay-connect">
				<div class="relay-heading">
					<Network :size="25" />
					<div>
						<h2>Connect to Relay management</h2>
						<p>Browse Hybrid Connections, WCF Relay resources and SAS policies.</p>
					</div>
				</div>
				<p class="field-hint">
					Administration requires Microsoft Entra permissions on the Relay namespace. A
					SAS connection string grants separate data access. No SAS credential is needed
					or unlocked by this connection.
				</p>
				<form class="relay-form" @submit.prevent="connect">
					<label
						>Relay namespace resource ID<Input
							v-model="management.resourceId"
							placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Relay/namespaces/…"
					/></label>
					<div class="relay-fields">
						<label>Relay management tenant<Input v-model="management.tenantId" /></label
						><label
							>Relay management client<Input v-model="management.clientId"
						/></label>
					</div>
					<p class="field-hint">
						Use an Entra app registration with public client flows enabled. Read
						permission allows browsing; creation, editing, deletion and keys require
						their respective ARM permissions.
					</p>
					<p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
					<div class="relay-actions">
						<Button type="submit" :disabled="!workspace.ready || !!relay.busy"
							>Connect Relay</Button
						><Button
							type="button"
							variant="outline"
							:disabled="!!relay.busy"
							@click="emit('settings')"
							>Connection settings</Button
						><Button
							type="button"
							variant="ghost"
							:disabled="!!relay.busy"
							@click="emit('remove')"
							>Remove profile</Button
						>
					</div>
				</form>
			</div></template
		>
		<template v-else>
			<div class="relay-toolbar">
				<span class="relay-connected"><span class="status-dot ready" />Relay connected</span
				><span class="field-hint"
					>{{ relay.connection?.location }} · Management access</span
				>
				<div class="relay-actions">
					<Button
						variant="outline"
						size="sm"
						:disabled="!!relay.busy"
						@click="configuration = { ...relay.selected }"
						>Relay configuration…</Button
					>
					<Button
						variant="outline"
						size="sm"
						:disabled="!!relay.busy"
						@click="relay.refresh()"
						><RefreshCw :size="14" />Refresh namespace</Button
					><Button
						variant="ghost"
						size="sm"
						:disabled="!!relay.busy"
						@click="relay.disconnect()"
						>Disconnect Relay</Button
					>
				</div>
			</div>
			<div class="relay-layout" :class="{ 'tree-hidden': !layout.treeVisible }">
				<nav v-if="layout.treeVisible" class="relay-tree" aria-label="Relay resources">
					<div class="relay-tree-tools">
						<strong>RESOURCES</strong
						><Button
							variant="ghost"
							size="sm"
							@click="
								expanded.hybrid = expanded.wcf = !(expanded.hybrid || expanded.wcf)
							"
							>{{
								expanded.hybrid || expanded.wcf ? 'Collapse all' : 'Expand all'
							}}</Button
						>
					</div>
					<RelayMenu :scope="relayNamespace" @action="action"
						><button
							class="relay-node namespace"
							:class="{ selected: relay.selected.kind === 'namespace' }"
							:disabled="!!relay.busy"
							@click="relay.select(relayNamespace)"
						>
							<Network :size="16" /><span>{{ profile.namespace }}</span>
						</button></RelayMenu
					>
					<section v-for="kind in ['hybrid', 'wcf'] as const" :key="kind">
						<button
							class="relay-group"
							:aria-expanded="expanded[kind]"
							@click="expanded[kind] = !expanded[kind]"
						>
							<ChevronDown v-if="expanded[kind]" :size="15" /><ChevronRight
								v-else
								:size="15"
							/>{{ kind === 'hybrid' ? 'Hybrid Connections' : 'WCF Relays'
							}}<span
								>{{ relay[kind].items.length
								}}{{ relay[kind].continuationToken ? '+' : '' }}</span
							>
						</button>
						<div v-if="expanded[kind]" class="relay-branch">
							<RelayMenu
								v-for="item in relay[kind].items"
								:key="item.target.scope.name"
								:scope="item.target.scope"
								@action="action"
								><button
									class="relay-node"
									:aria-label="`${scopeLabel(item.target.scope)} ${item.target.scope.name}`"
									:class="{
										selected:
											relay.selected.kind === kind &&
											relay.selected.name === item.target.scope.name,
									}"
									:disabled="!!relay.busy"
									@click="relay.select(item.target.scope)"
								>
									<Radio :size="14" /><span>{{ item.target.scope.name }}</span
									><small
										v-if="item.listenerCount !== null"
										:title="`${item.listenerCount} listeners at last list refresh`"
										>{{ item.listenerCount }}</small
									>
								</button></RelayMenu
							>
							<p v-if="!relay[kind].items.length" class="field-hint">
								No resources loaded.
							</p>
							<Button
								v-if="relay[kind].continuationToken"
								variant="ghost"
								size="sm"
								:disabled="!!relay.busy"
								@click="relay.list(kind, true)"
								>Load more
								{{
									kind === 'hybrid' ? 'Hybrid Connections' : 'WCF Relays'
								}}</Button
							>
						</div>
					</section>
				</nav>
				<div class="relay-content">
					<div class="relay-heading">
						<div>
							<div class="eyebrow">{{ scopeLabel(relay.selected) }}</div>
							<h2>{{ relay.selected.name || profile.namespace }}</h2>
						</div>
						<div class="relay-actions">
							<template v-if="relay.selected.kind === 'namespace'"
								><Button
									size="sm"
									:disabled="relay.blocked"
									@click="create('hybrid')"
									><Plus :size="14" />Create Hybrid Connection</Button
								><Button
									size="sm"
									variant="outline"
									:disabled="relay.blocked"
									@click="create('wcf')"
									>Create WCF Relay</Button
								></template
							><template v-else
								><Button
									size="sm"
									variant="outline"
									:disabled="relay.blocked || !relay.details"
									@click="editor = { action: 'update', target: target() }"
									>Edit resource</Button
								><Button
									size="sm"
									variant="outline"
									:disabled="!!relay.busy"
									@click="copy(relay.selected)"
									>Copy endpoint</Button
								><Button
									size="sm"
									variant="destructive"
									:disabled="relay.blocked || !relay.details"
									@click="editor = { action: 'delete', target: target() }"
									>Delete resource</Button
								></template
							>
						</div>
					</div>
					<p v-if="copied" role="status">{{ copied }}</p>
					<p v-if="relay.selected.kind === 'wcf'" class="field-hint">
						WCF resource management is supported. Legacy WCF binding tests are excluded.
					</p>
					<p v-if="relay.selected.kind === 'hybrid'" class="field-hint">
						Use Test Hybrid Connection to send requests or run an HTTP or stream
						listener.
					</p>
					<div v-if="relay.details" class="relay-properties">
						<h3>Properties</h3>
						<p v-if="relay.details.warning" class="form-warning">
							{{ relay.details.warning }}
						</p>
						<dl>
							<template
								v-for="property in relay.details.properties"
								:key="property.name"
								><dt>{{ propertyLabels[property.name] ?? property.name }}</dt>
								<dd>{{ property.value }}</dd></template
							>
						</dl>
					</div>
					<div class="relay-policies">
						<div class="relay-heading">
							<h3>SAS policies</h3>
							<div class="relay-actions">
								<Button
									size="sm"
									variant="ghost"
									:disabled="!!relay.busy"
									@click="relay.listPolicies()"
									>Refresh policies</Button
								><Button
									size="sm"
									variant="outline"
									:disabled="relay.blocked || !relay.details"
									@click="
										editor = {
											action: 'create',
											target: target(relay.selected, 'new-policy'),
										}
									"
									>Create SAS policy</Button
								>
							</div>
						</div>
						<p class="field-hint">
							Policies grant access to {{ relay.selected.name || 'the namespace' }}.
							Keys stay hidden until requested.
						</p>
						<table v-if="relay.policies.items.length" class="relay-policy-table">
							<thead>
								<tr>
									<th>Policy</th>
									<th>Rights</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="item in relay.policies.items"
									:key="item.target.policyName!"
									:aria-label="`Policy ${item.target.policyName}`"
								>
									<td>{{ item.target.policyName }}</td>
									<td>{{ item.rights?.join(', ') }}</td>
									<td>
										<div class="relay-actions">
											<Button
												size="sm"
												variant="ghost"
												:disabled="relay.blocked"
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
												:disabled="!!relay.busy"
												@click="keys = item.target"
												>Keys</Button
											><Button
												size="sm"
												variant="ghost"
												:disabled="relay.blocked"
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
													relay.blocked ||
													(relay.selected.kind === 'namespace' &&
														item.target.policyName ===
															'RootManageSharedAccessKey')
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
							v-if="relay.policies.continuationToken"
							variant="outline"
							size="sm"
							:disabled="!!relay.busy"
							@click="relay.listPolicies(true)"
							>Load more policies</Button
						>
					</div>
				</div>
			</div>
			<div v-if="relay.configOutcome" class="relay-receipt" role="status">
				<strong>Last Relay import · {{ relay.configOutcome.status }}</strong>
				<p>{{ relay.configOutcome.summary }}</p>
				<small>Receipt: {{ relay.configOutcome.operationId }}</small>
				<Button
					variant="outline"
					size="sm"
					:disabled="!!relay.busy"
					@click="configuration = { ...relay.selected }"
					>View import results</Button
				>
				<template v-if="relay.configOutcome.status === 'unknown'"
					><Button
						variant="outline"
						size="sm"
						:disabled="!!relay.busy"
						@click="relay.recoverConfiguration()"
						>Check retained import receipt</Button
					><label class="checkbox-label"
						><input
							v-model="relay.configReviewed"
							type="checkbox"
							:disabled="!!relay.busy"
						/>I checked Azure state and reviewed the uncertain import before another
						change.</label
					></template
				>
			</div>
			<div v-if="relay.outcome" class="relay-receipt" role="status">
				<strong>Last Relay change · {{ relay.outcome.status }}</strong>
				<p>{{ relay.outcome.summary }}</p>
				<small>Receipt: {{ relay.outcome.operationId }}</small
				><template v-if="relay.outcome.status === 'unknown'"
					><Button
						variant="outline"
						size="sm"
						:disabled="!!relay.busy"
						@click="relay.recover()"
						>Check retained receipt</Button
					><label class="checkbox-label"
						><input
							v-model="relay.reviewed"
							type="checkbox"
							:disabled="!!relay.busy"
						/>I checked Azure state and reviewed the uncertain outcome before another
						change.</label
					></template
				>
			</div>
		</template>
		<div v-if="relay.busy" class="relay-working" role="status">
			{{ relay.busy }}…<Button size="sm" variant="outline" @click="relay.cancel()"
				>Cancel Relay operation</Button
			>
		</div>
		<p v-if="relay.error" class="form-error" role="alert">{{ relay.error }}</p>
		<RelayEditor
			v-if="editor && connected"
			:key="`${editor.action}:${editor.target.scope.kind}:${editor.target.scope.name}:${editor.target.policyName}`"
			:target="editor.target"
			:action="editor.action"
			@close="editor = undefined"
		/>
		<RelayConfiguration
			v-if="configuration && connected"
			:scope="configuration"
			@close="configuration = undefined"
		/>
		<RelayKeys v-if="keys && connected" :target="keys" @close="keys = undefined" />
	</section>
</template>
<style>
.relay-explorer {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-height: 0;
	flex: 1;
}
.relay-connect {
	max-width: 800px;
	padding: 24px;
	border: 1px solid var(--border);
	border-radius: 12px;
	background: var(--card);
}
.relay-heading,
.relay-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 14px;
	flex-wrap: wrap;
}
.relay-heading h2 {
	font-size: 20px;
	margin: 4px 0;
	overflow-wrap: anywhere;
}
.relay-heading p {
	color: var(--muted-foreground);
	font-size: 13px;
}
.relay-actions {
	display: flex;
	gap: 6px;
	align-items: center;
	flex-wrap: wrap;
}
.relay-form,
.relay-form fieldset {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 0;
}
.relay-form {
	margin-top: 18px;
}
.relay-fields {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 14px;
}
.relay-form label,
.relay-dialog > label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
	font-weight: 500;
}
.relay-form label.checkbox-label {
	flex-direction: row;
	align-items: center;
}
.relay-form textarea,
.relay-dialog textarea,
.relay-dialog select {
	width: 100%;
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	background: var(--background);
	color: var(--foreground);
	font-size: 13px;
}
.relay-dialog {
	max-height: 85vh;
	overflow: auto;
}
.relay-dialog textarea {
	font-family: var(--font-mono, monospace);
	overflow-wrap: anywhere;
}
.relay-toolbar {
	padding: 10px 14px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--card);
}
.relay-connected {
	display: flex;
	gap: 8px;
	align-items: center;
	font-size: 13px;
	font-weight: 600;
}
.relay-layout {
	display: grid;
	grid-template-columns: minmax(220px, 28%) minmax(0, 1fr);
	border: 1px solid var(--border);
	border-radius: 10px;
	overflow: hidden;
	flex: 1;
	min-height: 300px;
	background: var(--card);
}
.relay-layout.tree-hidden {
	grid-template-columns: minmax(0, 1fr);
}
.relay-tree {
	border-right: 1px solid var(--border);
	padding: 12px;
	overflow: auto;
	min-width: 0;
}
.relay-tree-tools {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-size: 10px;
	color: var(--muted-foreground);
}
.relay-node,
.relay-group {
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
.relay-node:hover,
.relay-group:hover {
	background: var(--muted);
}
.relay-node.selected {
	background: var(--accent);
	color: var(--accent-foreground);
}
.relay-node > span {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.relay-node > svg {
	flex-shrink: 0;
}
.relay-node small,
.relay-group > span {
	margin-left: auto;
	color: var(--muted-foreground);
}
.relay-node:disabled {
	opacity: 0.6;
}
.relay-node:focus-visible,
.relay-group:focus-visible {
	outline: 2px solid var(--ring);
	outline-offset: -2px;
}
.relay-group {
	margin-top: 10px;
	font-weight: 600;
}
.relay-branch {
	padding-left: 12px;
}
.relay-branch > p {
	padding: 10px;
}
.relay-content {
	padding: 20px;
	overflow: auto;
	min-width: 0;
}
.relay-content > p {
	margin: 8px 0;
}
.relay-properties,
.relay-policies {
	margin-top: 20px;
}
.relay-properties h3,
.relay-policies h3 {
	font-size: 13px;
	font-weight: 600;
}
.relay-properties dl {
	display: grid;
	grid-template-columns: minmax(120px, 30%) 1fr;
	font-size: 12px;
	gap: 8px 16px;
	padding: 12px 0;
}
.relay-properties dt {
	color: var(--muted-foreground);
}
.relay-properties dd {
	overflow-wrap: anywhere;
	min-width: 0;
}
.relay-policy-table {
	width: 100%;
	text-align: left;
	font-size: 12px;
	margin: 12px 0;
}
.relay-policy-table th {
	font-weight: 500;
	color: var(--muted-foreground);
	border-bottom: 1px solid var(--border);
	padding: 8px 4px;
}
.relay-policy-table td {
	padding: 8px 4px;
	border-bottom: 1px solid var(--border);
	overflow-wrap: anywhere;
}
.relay-receipt {
	border: 1px solid var(--border);
	background: var(--muted);
	border-radius: 8px;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.relay-receipt > button {
	align-self: flex-start;
}
.relay-working {
	display: flex;
	align-items: center;
	gap: 14px;
	font-size: 12px;
}
</style>
