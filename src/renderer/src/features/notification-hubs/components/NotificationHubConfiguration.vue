<script setup lang="ts">
import { notificationHubsApi } from '@/features/notification-hubs/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import {
	nhPath,
	nhNamespace,
	type NotificationHubScope,
} from '@shared/contracts/notification-hubs/core'
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
import { useWorkspace } from '@/shared/workspace/store'
const props = defineProps<{ scope: NotificationHubScope }>(),
	emit = defineEmits<{ close: [] }>(),
	nh = useNotificationHubs()
const tab = ref<'import' | 'export' | 'results'>(nh.configOutcome ? 'results' : 'import'),
	format = ref<'json'>('json'),
	wholeNamespace = ref(props.scope.kind === 'namespace'),
	selected = ref<string[]>([]),
	ack = ref(false),
	saved = ref(''),
	warnings = ref<string[]>([])
const workspace = useWorkspace(),
	progress = computed(() => workspace.jobs.find((job) => job.id === nh.operationId)),
	signIn = computed(() =>
		workspace.jobs.find(
			(job) => job.id === nh.operationId && job.status === 'running' && job.code,
		),
	)
async function login() {
	const response = await notificationHubsApi.openDeviceLogin()
	if (!response.ok) nh.error = response.error.message
}
const exportScope = computed(() => (wholeNamespace.value ? nhNamespace : props.scope))
watch(
	() => nh.configPreview,
	(value) => {
		selected.value = value?.entries.filter((e) => e.action === 'create').map((e) => e.id) ?? []
		ack.value = false
	},
	{ immediate: true },
)
watch(
	selected,
	() => {
		ack.value = false
	},
	{ deep: true },
)
function selectCreates() {
	selected.value =
		nh.configPreview?.entries.filter((e) => e.action === 'create').map((e) => e.id) ?? []
}
async function load() {
	const value = await nh.importConfiguration()
	if (value && !value.cancelled) tab.value = 'import'
}
async function apply() {
	if (!ack.value) return
	const result = await nh.applyConfiguration([...selected.value])
	if (result) {
		ack.value = false
		tab.value = 'results'
	}
}
async function save() {
	saved.value = ''
	warnings.value = []
	const scope = { ...exportScope.value }
	const value = await nh.run('Export Notification Hubs configuration', (id, connectionId) =>
		notificationHubsApi.exportNotificationHubConfiguration({
			id,
			connectionId,
			scope,
			format: format.value,
		}),
	)
	if (value && !value.cancelled) {
		saved.value = `Saved ${value.count} targets to ${value.fileName}.`
		warnings.value = value.warnings ?? []
	}
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !nh.busy && emit('close')"
		><DialogContent
			class="sm:max-w-[900px] nh-config-dialog"
			:show-close-button="false"
			@escape-key-down="nh.busy && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Notification Hubs configuration</DialogTitle
				><DialogDescription
					>{{ nh.connection?.namespace }} · Import or export resource settings and SAS
					policy rights.</DialogDescription
				></DialogHeader
			>
			<div
				class="nh-actions"
				role="tablist"
				aria-label="Notification Hubs configuration views"
			>
				<Button
					v-for="item in ['import', 'export', 'results'] as const"
					:key="item"
					role="tab"
					:aria-selected="tab === item"
					:variant="tab === item ? 'default' : 'outline'"
					:disabled="!!nh.busy"
					@click="tab = item"
					>{{
						item === 'import' ? 'Import' : item === 'export' ? 'Export' : 'Results'
					}}</Button
				>
			</div>
			<div class="nh-config-scroll">
				<section v-if="signIn" aria-label="Configuration Microsoft sign-in">
					<p>Sign in again to continue this configuration operation.</p>
					<p class="device-code">{{ signIn.code }}</p>
					<Button variant="outline" @click="login">Open Microsoft sign-in</Button>
				</section>
				<template v-if="tab === 'export'">
					<p>
						Export
						{{
							exportScope.kind === 'namespace'
								? 'the namespace'
								: nhPath({ scope: exportScope, policyName: null })
						}}.
					</p>
					<label v-if="scope.kind !== 'namespace'" class="checkbox-label"
						><input
							v-model="wholeNamespace"
							type="checkbox"
							:disabled="!!nh.busy"
						/>Export the whole namespace</label
					>

					<p class="field-hint">
						Files exclude provider credentials, keys, registrations and installations.
						New policies receive new keys; existing policy keys and provider credentials
						are kept.
					</p>

					<Button :disabled="!!nh.busy" @click="save"
						>Save Notification Hubs configuration…</Button
					>
					<p v-if="saved" role="status">{{ saved }}</p>
					<p v-for="warning in warnings" :key="warning" class="form-warning">
						{{ warning }}
					</p>
				</template>
				<template v-else-if="tab === 'import'">
					<p>
						Choose a Commander Notification Hubs JSON file. Review every selected target
						before applying.
					</p>
					<Button variant="outline" :disabled="!!nh.busy" @click="load"
						>Choose Notification Hubs configuration…</Button
					>
					<template v-if="nh.configPreview">
						<div class="nh-config-destination">
							<strong>{{ nh.configFileName }}</strong>
							<p>Source: {{ nh.configPreview.sourceNamespace }}</p>
							<p>Destination: {{ nh.configPreview.destinationNamespace }}</p>
							<small
								>Preview expires
								{{
									new Date(nh.configPreview.expiresAt).toLocaleTimeString()
								}}.</small
							>
						</div>
						<details class="nh-config-notes">
							<summary>
								Compatibility notes ·
								{{ nh.configPreview.warnings.length }} (credentials and keys
								excluded)
							</summary>
							<p
								v-for="warning in nh.configPreview.warnings"
								:key="warning"
								class="form-warning"
							>
								{{ warning }}
							</p>
						</details>
						<p class="field-hint">
							Existing targets start unchecked. An update changes the listed settings
							or rights and keeps existing keys and provider credentials. JSON can
							replace the displayed tags. Nothing is deleted. Imports stop on the
							first failure, cancellation, uncertain write or the two-minute limit.
							Confirmed changes stay applied.
						</p>
						<div class="nh-actions">
							<Button
								variant="ghost"
								size="sm"
								:disabled="!!nh.busy"
								@click="selectCreates"
								>Select creates only</Button
							><Button
								variant="ghost"
								size="sm"
								:disabled="!!nh.busy"
								@click="selected = []"
								>Clear selection</Button
							><span>{{ selected.length }} selected</span>
						</div>
						<table class="relay-policy-table nh-config-table">
							<thead>
								<tr>
									<th>Select</th>
									<th>Target and proposed change</th>
									<th>Settings / rights</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="entry in nh.configPreview.entries" :key="entry.id">
									<td>
										<input
											v-model="selected"
											:value="entry.id"
											type="checkbox"
											:aria-label="`Import ${nhPath(entry.target)}`"
											:disabled="!!nh.busy || entry.action === 'blocked'"
										/>
									</td>
									<td>
										<strong>{{ nhPath(entry.target) }}</strong>
										<p>{{ entry.action }}</p>
										<p v-if="entry.issue" class="form-warning">
											{{ entry.issue }}
										</p>
									</td>
									<td>
										<details>
											<summary>Review settings</summary>
											<template v-if="entry.action === 'update'"
												><small>Current</small>
												<pre>{{
													JSON.stringify(
														entry.currentSettings ??
															entry.currentRights,
														null,
														2,
													)
												}}</pre></template
											><small>Import</small>
											<pre>{{
												JSON.stringify(
													entry.settings ?? entry.rights,
													null,
													2,
												)
											}}</pre>
										</details>
									</td>
								</tr>
							</tbody>
						</table>
						<label class="checkbox-label"
							><input
								v-model="ack"
								type="checkbox"
								:disabled="nh.blocked || !selected.length"
							/>I reviewed the destination, selected creates and updates, excluded
							fields and key behavior.</label
						>
						<Button :disabled="nh.blocked || !ack || !selected.length" @click="apply"
							>Apply selected Notification Hubs configuration</Button
						>
					</template>
				</template>
				<template v-else>
					<template v-if="nh.configOutcome"
						><p role="status">{{ nh.configOutcome.summary }}</p>
						<small>Receipt: {{ nh.configOutcome.operationId }}</small>
						<table class="relay-policy-table">
							<thead>
								<tr>
									<th>Target</th>
									<th>Result</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="step in nh.configOutcome.steps"
									:key="nhPath(step.target)"
								>
									<td>{{ nhPath(step.target) }}</td>
									<td>
										{{ step.status }}
										<p v-if="step.receipt">{{ step.receipt.summary }}</p>
									</td>
								</tr>
							</tbody>
						</table>
						<Button
							variant="outline"
							:disabled="!!nh.busy"
							@click="nh.recoverConfiguration()"
							>Check retained import receipt</Button
						><label v-if="nh.configOutcome.status === 'unknown'" class="checkbox-label"
							><input
								v-model="nh.configReviewed"
								type="checkbox"
								:disabled="!!nh.busy"
							/>I checked Azure state and reviewed the uncertain import before another
							change.</label
						></template
					>
					<p v-else>No import results yet.</p>
				</template>
				<p v-if="nh.error" class="form-error" role="alert">{{ nh.error }}</p>
			</div>
			<DialogFooter
				><template v-if="nh.busy"
					><div role="status">
						<p>{{ nh.busy }}…</p>
						<p>{{ progress?.message }}</p>
						<progress
							v-if="progress?.percent !== undefined"
							aria-label="Notification Hubs import progress"
							:value="progress.percent"
							max="100"
						/>
					</div>
					<Button variant="outline" @click="nh.cancel()"
						>Cancel Notification Hubs operation</Button
					></template
				><Button variant="outline" :disabled="!!nh.busy" @click="emit('close')"
					>Close Notification Hubs configuration</Button
				></DialogFooter
			>
		</DialogContent></Dialog
	>
</template>
<style>
.nh-config-dialog {
	display: flex;
	flex-direction: column;
	max-height: 90vh;
	gap: 16px;
}
.nh-config-scroll {
	overflow: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 14px;
	padding-right: 4px;
}
.nh-config-scroll > button {
	align-self: flex-start;
}
.nh-config-destination {
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--muted);
	overflow-wrap: anywhere;
	font-size: 13px;
}
.nh-config-scroll pre {
	font-size: 11px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-width: 350px;
	padding: 8px;
	background: var(--muted);
	border-radius: 6px;
}
.nh-config-notes {
	font-size: 13px;
}
.nh-config-notes summary {
	cursor: pointer;
}
.nh-config-notes p {
	margin-top: 8px;
}
.nh-config-table td {
	vertical-align: top;
}
.nh-config-format {
	font-size: 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.nh-config-format select {
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	background: var(--background);
	color: var(--foreground);
	max-width: 100%;
}
</style>
