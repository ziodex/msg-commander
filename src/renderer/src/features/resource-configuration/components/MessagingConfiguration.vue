<script setup lang="ts">
import { resourceConfigurationApi } from '@/features/resource-configuration/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import type { ConfigurationConnection } from '../model/connection'
import { useWorkspace } from '@/shared/workspace/store'
import { useMessagingConfiguration } from '@/features/resource-configuration/stores/messaging-configuration'
import {
	messagingConfigPath,
	type MessagingService,
	type MessagingConfigTarget,
} from '@shared/contracts/resource-configuration'
const props = defineProps<{
	service: MessagingService
	connection: ConfigurationConnection
	scope: MessagingConfigTarget | null
	hideTrigger?: boolean
}>()
const emit = defineEmits<{ changed: [] }>()
const workspace = useWorkspace(),
	configs = useMessagingConfiguration()
const visible = ref(false),
	tab = ref<'import' | 'export' | 'results'>('import'),
	wholeNamespace = ref(true),
	format = ref<'json'>('json'),
	policies = ref(false),
	selected = ref<string[]>([]),
	ack = ref(false)
const active = computed(() => props.connection),
	state = computed(() => configs.states[props.service]),
	title = computed(() =>
		props.service === 'service-bus' ? 'Service Bus configuration' : 'Event Hubs configuration',
	)
const job = computed(() => workspace.jobs.find((j) => j.id === state.value.operationId))
const unresolved = computed(
	() => state.value.interrupted || state.value.result?.status === 'unknown',
)
const missing = computed(() => {
	const entries = state.value.preview?.entries ?? []
	return entries
		.filter((e) => selected.value.includes(e.id))
		.some(
			(e) =>
				e.dependsOn.some((id) => !selected.value.includes(id)) ||
				(e.action === 'create' &&
					entries.some(
						(other) =>
							messagingConfigPath(other.target) === messagingConfigPath(e.target) &&
							(other.phase === 'forwarding' ||
								(e.target.kind === 'subscription' && other.phase === 'activate')) &&
							!selected.value.includes(other.id),
					)),
		)
})
watch(
	() => state.value.preview,
	(value) => {
		// Existing changes require explicit selection. Include the safety steps required by new resources.
		selected.value =
			value?.entries.filter((e) => e.action === 'create' && !e.issue).map((e) => e.id) ?? []
		if (value) {
			const needed = new Set(selected.value)
			for (const created of value.entries.filter((e) => e.action === 'create' && !e.issue))
				for (const forward of value.entries.filter(
					(e) =>
						e.phase === 'forwarding' &&
						messagingConfigPath(e.target) === messagingConfigPath(created.target) &&
						!e.issue,
				))
					needed.add(forward.id)
			for (const sub of value.entries.filter(
				(e) => e.target.kind === 'subscription' && e.action === 'create',
			))
				for (const step of value.entries.filter(
					(e) =>
						(e.target.kind === 'subscription' &&
							messagingConfigPath(e.target) === messagingConfigPath(sub.target)) ||
						(e.phase === 'remove-guard' &&
							e.target.parentName ===
								`${sub.target.parentName}/Subscriptions/${sub.target.name}`),
				))
					if (!step.issue) needed.add(step.id)
			selected.value = [...needed]
		}
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
watch(
	() => active.value.connection?.connectionId,
	(connectionId) => {
		configs.syncConnection(props.service, connectionId)
		visible.value = false
		ack.value = false
	},
	{ immediate: true, flush: 'sync' },
)
function open() {
	visible.value = true
	tab.value = state.value.result || state.value.interrupted ? 'results' : 'import'
	ack.value = false
}
async function save() {
	state.value.notice = ''
	state.value.warnings = []
	const scope = wholeNamespace.value ? null : props.scope
	const value = await configs.run(
		props.service,
		active.value,
		'Export messaging configuration',
		(id, connectionId) =>
			resourceConfigurationApi.exportMessagingConfiguration({
				id,
				connectionId,
				service: props.service,
				scope,
				format: format.value,
				includePolicies: policies.value,
			}),
	)
	if (value && !value.cancelled) {
		state.value.notice = `Saved ${value.count} targets to ${value.fileName}.`
		state.value.warnings = value.warnings ?? []
	}
}
async function apply() {
	if (!ack.value || missing.value) return
	const value = await configs.apply(props.service, active.value, [...selected.value])
	ack.value = false
	if (value || state.value.interrupted) {
		tab.value = 'results'
		emit('changed')
	}
}
const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const phaseLabel = (phase: string) =>
	({
		resource: 'Settings',
		forwarding: 'Forwarding',
		'remove-guard': 'Remove temporary filter',
		activate: 'Final status',
	})[phase] ?? phase
const displayTarget = (target: MessagingConfigTarget, phase: string) =>
	phase === 'remove-guard'
		? `${target.parentName}/temporary import filter`
		: messagingConfigPath(target)
async function login() {
	await resourceConfigurationApi.openDeviceLogin()
}
function reviewed() {
	configs.reviewed(props.service)
	tab.value = 'import'
}
defineExpose({ open })
</script>
<template>
	<Button
		v-if="!hideTrigger"
		variant="outline"
		size="sm"
		:disabled="
			!!active.busy ||
			!active.connection ||
			(service === 'event-hubs' && !active.connection?.managementAvailable)
		"
		@click="open"
		>{{ title }}…</Button
	>
	<Dialog :open="visible" @update:open="!active.busy && (visible = $event)"
		><DialogContent
			class="message-inspection-dialog messaging-config-dialog"
			@interact-outside="$event.preventDefault()"
			@escape-key-down="active.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription
					>{{ active.connection?.namespace }} · Import or export resource settings,
					relationships and policy rights.</DialogDescription
				></DialogHeader
			>
			<p v-if="active.error" role="alert" class="error-banner">{{ active.error }}</p>
			<div class="explorer-actions" role="tablist" aria-label="Configuration views">
				<Button
					v-for="item in ['import', 'export', 'results'] as const"
					:key="item"
					role="tab"
					:aria-selected="tab === item"
					:variant="tab === item ? 'default' : 'outline'"
					:disabled="!!active.busy"
					@click="tab = item"
					>{{
						item === 'import' ? 'Import' : item === 'export' ? 'Export' : 'Results'
					}}</Button
				>
			</div>
			<p class="explorer-note">
				Files exclude SAS keys, credentials and message/event data. New policies receive new
				keys; existing keys are preserved. Existing targets start unchecked. New
				subscriptions stay disabled until their reviewed rules are installed.
			</p>
			<template v-if="tab === 'export'">
				<label v-if="scope" class="check-row"
					><input
						v-model="wholeNamespace"
						type="checkbox"
						:disabled="!!active.busy"
					/>Export the whole namespace</label
				>
				<p>
					Export:
					{{ wholeNamespace || !scope ? 'whole namespace' : messagingConfigPath(scope) }}
				</p>

				<label class="check-row"
					><input v-model="policies" type="checkbox" :disabled="!!active.busy" />Include
					policy rights (requires management access)</label
				>

				<p v-if="service === 'event-hubs'" class="explorer-note">
					Exports exclude Capture destinations and identities. Existing destination
					Capture is preserved; configure new hub Capture separately.
				</p>
				<Button :disabled="!!active.busy" @click="save">Save configuration…</Button>
			</template>
			<template v-else-if="tab === 'import'">
				<Button
					variant="outline"
					:disabled="!!active.busy || !!unresolved"
					@click="configs.load(service, active)"
					>Choose configuration…</Button
				>
				<template v-if="state.preview">
					<p>
						{{ state.fileName }} · Source: {{ state.preview.sourceNamespace }} ·
						Destination:
						<strong>{{ state.preview.destinationNamespace }}</strong>
					</p>
					<p class="explorer-note">
						Review expires {{ new Date(state.preview.expiresAt).toLocaleTimeString() }}.
						Selected updates replace the proposed fields; omitted fields preserve
						existing values. Forwarding is applied after resource creation. Imports stop
						on the first failure, cancellation or uncertain write; confirmed changes
						remain applied.
					</p>
					<p
						v-for="warning in state.preview.warnings"
						:key="warning"
						class="inspector-warning"
					>
						{{ warning }}
					</p>
					<div class="explorer-actions">
						<Button
							variant="ghost"
							:disabled="!!active.busy"
							@click="
								selected = state.preview.entries
									.filter((e) => !e.issue)
									.map((e) => e.id)
							"
							>Select all available steps</Button
						><Button variant="ghost" :disabled="!!active.busy" @click="selected = []"
							>Clear selection</Button
						><span>{{ selected.length }} selected</span>
					</div>
					<table class="property-table" aria-label="Configuration import steps">
						<thead>
							<tr>
								<th>Select</th>
								<th>Target</th>
								<th>Step</th>
								<th>Action</th>
								<th>Changes</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="entry in state.preview.entries" :key="entry.id">
								<td>
									<input
										v-model="selected"
										type="checkbox"
										:value="entry.id"
										:disabled="!!active.busy || !!entry.issue"
										:aria-label="`Import ${phaseLabel(entry.phase)} ${displayTarget(entry.target, entry.phase)}`"
									/>
								</td>
								<td>{{ displayTarget(entry.target, entry.phase) }}</td>
								<td>{{ phaseLabel(entry.phase) }}</td>
								<td>{{ entry.action }}</td>
								<td>
									<p v-if="entry.issue" class="error-banner">{{ entry.issue }}</p>
									<details v-else>
										<summary>Review settings</summary>
										<p>Current</p>
										<pre>{{ pretty(entry.current) }}</pre>
										<p>Proposed</p>
										<pre>{{ pretty(entry.proposed) }}</pre>
										<small>{{ entry.dependsOn.length }} required steps</small>
									</details>
								</td>
							</tr>
						</tbody>
					</table>
					<p v-if="missing" role="alert" class="inspector-warning">
						Include the required parent, rule, forwarding and final status steps.
					</p>
					<label class="check-row"
						><input v-model="ack" type="checkbox" :disabled="!!active.busy" />I reviewed
						the destination, selected changes, dependencies and new policy keys.</label
					>
					<Button
						:disabled="
							!!active.busy || !ack || !selected.length || !!missing || !!unresolved
						"
						@click="apply"
						>Apply selected configuration</Button
					>
				</template>
			</template>
			<template v-else>
				<p v-if="state.result" role="status">{{ state.result.summary }}</p>
				<p
					v-if="state.interrupted || state.result?.status === 'unknown'"
					class="inspector-warning"
				>
					The outcome may be uncertain. Recover the receipt and inspect Azure state before
					another import. Nothing was retried.
				</p>
				<Button
					v-if="state.interrupted"
					variant="outline"
					:disabled="!!active.busy"
					@click="configs.recover(service, active)"
					>Recover configuration result</Button
				>
				<table
					v-if="state.result"
					class="property-table"
					aria-label="Configuration import results"
				>
					<thead>
						<tr>
							<th>Target</th>
							<th>Step</th>
							<th>Status</th>
							<th>Detail</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="step in state.result.steps" :key="step.entryId">
							<td>{{ displayTarget(step.target, step.phase) }}</td>
							<td>{{ phaseLabel(step.phase) }}</td>
							<td>{{ step.status }}</td>
							<td>{{ step.summary }}</td>
						</tr>
					</tbody>
				</table>
				<Button
					v-if="unresolved"
					variant="outline"
					:disabled="!!active.busy"
					@click="reviewed"
					>I checked the result in Azure; start a fresh review</Button
				>
			</template>
			<p v-if="state.notice" role="status">{{ state.notice }}</p>
			<p v-for="warning in state.warnings" :key="warning" class="inspector-warning">
				{{ warning }}
			</p>
			<section v-if="active.busy" aria-label="Configuration operation">
				<p role="status">{{ active.busy }}… {{ job?.message }}</p>
				<template v-if="job?.code"
					><p class="device-code">{{ job.code }}</p>
					<Button variant="outline" @click="login"
						>Open Microsoft sign-in</Button
					></template
				><Button variant="outline" @click="workspace.cancel(state.operationId)"
					>Cancel configuration operation</Button
				>
			</section>
			<Button variant="outline" :disabled="!!active.busy" @click="visible = false"
				>Close configuration</Button
			>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.messaging-config-dialog {
	max-width: min(1100px, calc(100vw - 3rem));
}
label {
	display: grid;
	gap: 0.4rem;
}
.check-row {
	display: flex;
	align-items: flex-start;
	gap: 0.5rem;
}
select {
	padding: 0.5rem;
	border: 1px solid var(--border);
	background: var(--background);
	color: var(--foreground);
	border-radius: 0.4rem;
}
pre {
	max-width: 440px;
	max-height: 260px;
	overflow: auto;
	font-size: 0.75rem;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
</style>
