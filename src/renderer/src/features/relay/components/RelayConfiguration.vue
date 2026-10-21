<script setup lang="ts">
import { relayApi } from '@/features/relay/api'

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
import { relayPath, relayNamespace, type RelayScope } from '@shared/contracts/relay/core'
import { useRelay } from '@/features/relay/stores/relay'
import { useWorkspace } from '@/shared/workspace/store'
const props = defineProps<{ scope: RelayScope }>(),
	emit = defineEmits<{ close: [] }>(),
	relay = useRelay()
const tab = ref<'import' | 'export' | 'results'>(relay.configOutcome ? 'results' : 'import'),
	format = ref<'json'>('json'),
	wholeNamespace = ref(props.scope.kind === 'namespace'),
	selected = ref<string[]>([]),
	ack = ref(false),
	saved = ref(''),
	warnings = ref<string[]>([])
const workspace = useWorkspace(),
	progress = computed(() => workspace.jobs.find((job) => job.id === relay.operationId))
const exportScope = computed(() => (wholeNamespace.value ? relayNamespace : props.scope))
watch(
	() => relay.configPreview,
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
		relay.configPreview?.entries.filter((e) => e.action === 'create').map((e) => e.id) ?? []
}
async function load() {
	const value = await relay.importConfiguration()
	if (value && !value.cancelled) tab.value = 'import'
}
async function apply() {
	if (!ack.value) return
	const result = await relay.applyConfiguration([...selected.value])
	if (result) {
		ack.value = false
		tab.value = 'results'
	}
}
async function save() {
	saved.value = ''
	warnings.value = []
	const scope = { ...exportScope.value }
	const value = await relay.run('Export Relay configuration', (id, connectionId) =>
		relayApi.exportRelayConfiguration({ id, connectionId, scope, format: format.value }),
	)
	if (value && !value.cancelled) {
		saved.value = `Saved ${value.count} targets to ${value.fileName}.`
		warnings.value = value.warnings ?? []
	}
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !relay.busy && emit('close')"
		><DialogContent
			class="sm:max-w-[900px] relay-config-dialog"
			:show-close-button="false"
			@escape-key-down="relay.busy && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Relay configuration</DialogTitle
				><DialogDescription
					>{{ relay.connection?.namespace }} · Import or export resource settings and SAS
					policy rights.</DialogDescription
				></DialogHeader
			>
			<div class="relay-actions" role="tablist" aria-label="Relay configuration views">
				<Button
					v-for="item in ['import', 'export', 'results'] as const"
					:key="item"
					role="tab"
					:aria-selected="tab === item"
					:variant="tab === item ? 'default' : 'outline'"
					:disabled="!!relay.busy"
					@click="tab = item"
					>{{
						item === 'import' ? 'Import' : item === 'export' ? 'Export' : 'Results'
					}}</Button
				>
			</div>
			<div class="relay-config-scroll">
				<template v-if="tab === 'export'">
					<p>
						Export
						{{
							exportScope.kind === 'namespace'
								? 'the namespace'
								: relayPath({ scope: exportScope, policyName: null })
						}}.
					</p>
					<label v-if="scope.kind !== 'namespace'" class="checkbox-label"
						><input
							v-model="wholeNamespace"
							type="checkbox"
							:disabled="!!relay.busy"
						/>Export the whole namespace</label
					>

					<p class="field-hint">
						Files contain resource settings and policy rights. SAS keys are excluded.
						New policies receive new keys; existing policy keys are kept.
					</p>

					<Button :disabled="!!relay.busy" @click="save"
						>Save Relay configuration…</Button
					>
					<p v-if="saved" role="status">{{ saved }}</p>
					<p v-for="warning in warnings" :key="warning" class="form-warning">
						{{ warning }}
					</p>
				</template>
				<template v-else-if="tab === 'import'">
					<p>
						Choose a Commander Relay JSON file. Review every selected target before
						applying.
					</p>
					<Button variant="outline" :disabled="!!relay.busy" @click="load"
						>Choose Relay configuration…</Button
					>
					<template v-if="relay.configPreview">
						<div class="relay-config-destination">
							<strong>{{ relay.configFileName }}</strong>
							<p>Source: {{ relay.configPreview.sourceNamespace }}</p>
							<p>Destination: {{ relay.configPreview.destinationNamespace }}</p>
							<small
								>Preview expires
								{{
									new Date(relay.configPreview.expiresAt).toLocaleTimeString()
								}}.</small
							>
						</div>
						<p
							v-for="warning in relay.configPreview.warnings"
							:key="warning"
							class="form-warning"
						>
							{{ warning }}
						</p>
						<p class="field-hint">
							Existing targets start unchecked. An update changes the listed settings
							or rights and keeps existing keys. Nothing is deleted. Imports stop on
							the first failure, cancellation, uncertain write or the two-minute
							limit. Confirmed changes stay applied.
						</p>
						<div class="relay-actions">
							<Button
								variant="ghost"
								size="sm"
								:disabled="!!relay.busy"
								@click="selectCreates"
								>Select creates only</Button
							><Button
								variant="ghost"
								size="sm"
								:disabled="!!relay.busy"
								@click="selected = []"
								>Clear selection</Button
							><span>{{ selected.length }} selected</span>
						</div>
						<table class="relay-policy-table relay-config-table">
							<thead>
								<tr>
									<th>Select</th>
									<th>Target and proposed change</th>
									<th>Settings / rights</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="entry in relay.configPreview.entries" :key="entry.id">
									<td>
										<input
											v-model="selected"
											:value="entry.id"
											type="checkbox"
											:aria-label="`Import ${relayPath(entry.target)}`"
											:disabled="!!relay.busy || entry.action === 'blocked'"
										/>
									</td>
									<td>
										<strong>{{ relayPath(entry.target) }}</strong>
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
								:disabled="relay.blocked || !selected.length"
							/>I reviewed the destination, selected creates and updates, excluded
							fields and key behavior.</label
						>
						<Button :disabled="relay.blocked || !ack || !selected.length" @click="apply"
							>Apply selected Relay configuration</Button
						>
					</template>
				</template>
				<template v-else>
					<template v-if="relay.configOutcome"
						><p role="status">{{ relay.configOutcome.summary }}</p>
						<small>Receipt: {{ relay.configOutcome.operationId }}</small>
						<table class="relay-policy-table">
							<thead>
								<tr>
									<th>Target</th>
									<th>Result</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="step in relay.configOutcome.steps"
									:key="relayPath(step.target)"
								>
									<td>{{ relayPath(step.target) }}</td>
									<td>
										{{ step.status }}
										<p v-if="step.receipt">{{ step.receipt.summary }}</p>
									</td>
								</tr>
							</tbody>
						</table>
						<Button
							variant="outline"
							:disabled="!!relay.busy"
							@click="relay.recoverConfiguration()"
							>Check retained import receipt</Button
						><label
							v-if="relay.configOutcome.status === 'unknown'"
							class="checkbox-label"
							><input
								v-model="relay.configReviewed"
								type="checkbox"
								:disabled="!!relay.busy"
							/>I checked Azure state and reviewed the uncertain import before another
							change.</label
						></template
					>
					<p v-else>No import results yet.</p>
				</template>
				<p v-if="relay.error" class="form-error" role="alert">{{ relay.error }}</p>
			</div>
			<DialogFooter
				><template v-if="relay.busy"
					><div role="status">
						<p>{{ relay.busy }}…</p>
						<p>{{ progress?.message }}</p>
						<progress
							v-if="progress?.percent !== undefined"
							aria-label="Relay import progress"
							:value="progress.percent"
							max="100"
						/>
					</div>
					<Button variant="outline" @click="relay.cancel()"
						>Cancel Relay operation</Button
					></template
				><Button variant="outline" :disabled="!!relay.busy" @click="emit('close')"
					>Close Relay configuration</Button
				></DialogFooter
			>
		</DialogContent></Dialog
	>
</template>
<style>
.relay-config-dialog {
	display: flex;
	flex-direction: column;
	max-height: 90vh;
	gap: 16px;
}
.relay-config-scroll {
	overflow: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 14px;
	padding-right: 4px;
}
.relay-config-scroll > button {
	align-self: flex-start;
}
.relay-config-destination {
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--muted);
	overflow-wrap: anywhere;
	font-size: 13px;
}
.relay-config-scroll pre {
	font-size: 11px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-width: 350px;
	padding: 8px;
	background: var(--muted);
	border-radius: 6px;
}
.relay-config-table td {
	vertical-align: top;
}
.relay-config-format {
	font-size: 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.relay-config-format select {
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	background: var(--background);
	color: var(--foreground);
	max-width: 100%;
}
</style>
