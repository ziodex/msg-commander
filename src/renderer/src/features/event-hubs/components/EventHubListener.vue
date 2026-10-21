<script setup lang="ts">
import { eventHubsApi } from '@/features/event-hubs/api'

import { computed, ref, watch } from 'vue'
import EventOperationStatistics from './EventOperationStatistics.vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventListener } from '@/features/event-hubs/stores/event-hubs-listener'
import { eventListenSchema, type ListenerItem } from '@shared/contracts/event-hubs/listening'
const eh = useEventHubs(),
	listener = useEventListener(),
	visible = ref(false),
	settingsOpen = ref(true),
	hub = ref(''),
	group = ref('$Default'),
	start = ref<'earliest' | 'latest' | 'time' | 'checkpoint'>('earliest'),
	time = ref(new Date().toISOString()),
	concurrency = ref(4),
	maxEvents = ref(100),
	maxSeconds = ref(60),
	acknowledged = ref(false)
const emit = defineEmits<{ inspect: [item: ListenerItem] }>()
const parsed = computed(() =>
	eventListenSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: eh.connection?.connectionId,
		hubName: hub.value,
		consumerGroup: group.value,
		start:
			start.value === 'checkpoint'
				? { kind: 'checkpoint', checkpoint: listener.checkpoint }
				: start.value === 'time'
					? { kind: 'time', value: time.value }
					: { kind: start.value },
		concurrency: concurrency.value,
		maxEvents: maxEvents.value,
		maxSeconds: maxSeconds.value,
		acknowledged: acknowledged.value,
	}),
)
const progress = computed(() => listener.progress),
	rows = computed(() => listener.result?.partitions ?? progress.value?.partitions ?? []),
	received = computed(() => listener.result?.received ?? progress.value?.received ?? 0)
watch(
	() => listener.running,
	(value) => {
		if (value) settingsOpen.value = false
	},
)
watch(
	[hub, group, start, time, concurrency, maxEvents, maxSeconds],
	() => (acknowledged.value = false),
	{ flush: 'sync' },
)
watch(
	() => eh.connection?.connectionId,
	() => {
		visible.value = false
		acknowledged.value = false
	},
	{ flush: 'sync' },
)
function open(hubName = eh.hubName, consumerGroup = eh.consumerGroup) {
	if (listener.running && listener.target) {
		hub.value = listener.target.hubName
		group.value = listener.target.consumerGroup
		concurrency.value = listener.target.concurrency
		maxEvents.value = listener.target.maxEvents
		maxSeconds.value = listener.target.maxSeconds
		start.value = listener.target.start.kind
		if (listener.target.start.kind === 'time') time.value = listener.target.start.value
		if (listener.target.start.kind === 'checkpoint')
			listener.checkpoint = JSON.parse(JSON.stringify(listener.target.start.checkpoint))
	} else {
		hub.value = hubName
		group.value = consumerGroup
		acknowledged.value = false
	}
	settingsOpen.value = !listener.running && !listener.result
	visible.value = true
}
async function load() {
	if (await listener.loadCheckpoint(hub.value, group.value)) {
		start.value = 'checkpoint'
		settingsOpen.value = true
	}
	acknowledged.value = false
}
function resume() {
	if (listener.result?.checkpoint) {
		listener.checkpoint = structuredClone(
			JSON.parse(JSON.stringify(listener.result.checkpoint)),
		)
		hub.value = listener.result.hubName
		group.value = listener.result.consumerGroup
		start.value = 'checkpoint'
		settingsOpen.value = true
		acknowledged.value = false
	}
}
async function run() {
	if (parsed.value.success) {
		await listener.listen(parsed.value.data)
		acknowledged.value = false
	}
}
function inspect(item: ListenerItem) {
	visible.value = false
	emit('inspect', item)
}
async function login() {
	await eventHubsApi.openDeviceLogin()
}
defineExpose({ open })
</script>
<template>
	<Dialog :open="visible" @update:open="visible = $event"
		><DialogContent class="message-inspection-dialog listener-dialog"
			><DialogHeader
				><DialogTitle
					>Listen to all
					{{ eh.serviceName === 'IoT Hub' ? 'IoT Hub' : 'Event Hub' }}
					partitions</DialogTitle
				><DialogDescription
					>{{ eh.connection?.namespace }}. Non-exclusive receivers; no Azure checkpoint or
					ownership changes. Use a dedicated consumer group for
					inspection.</DialogDescription
				></DialogHeader
			>
			<p v-if="eh.error" role="alert" class="error-banner">{{ eh.error }}</p>
			<p v-if="listener.notice" role="status">{{ listener.notice }}</p>

			<details
				:open="settingsOpen"
				@toggle="settingsOpen = ($event.target as HTMLDetailsElement).open"
			>
				<summary>Listener settings</summary>
				<div class="listener-fields">
					<label
						>Event Hub<Input
							v-model="hub"
							aria-label="Listener Event Hub"
							:disabled="!!eh.busy || eh.connection?.service === 'iot-hub'"
					/></label>
					<label
						>Consumer group<Input
							v-model="group"
							aria-label="Listener consumer group"
							:disabled="!!eh.busy"
					/></label>
					<label
						>Starting position<select
							v-model="start"
							aria-label="Listener start position"
							:disabled="!!eh.busy"
						>
							<option value="earliest">Earliest retained events</option>
							<option value="latest">Latest at listener start</option>
							<option value="time">Enqueued at or after time</option>
							<option value="checkpoint" :disabled="!listener.checkpoint">
								Loaded/local checkpoint
							</option>
						</select></label
					>
					<label v-if="start === 'time'"
						>Time with timezone<Input
							v-model="time"
							aria-label="Listener start time"
							:disabled="!!eh.busy"
					/></label>
					<label
						>Concurrent receivers<Input
							v-model.number="concurrency"
							aria-label="Listener concurrency"
							type="number"
							min="1"
							max="16"
							:disabled="!!eh.busy"
					/></label>
					<label
						>Total event limit<Input
							v-model.number="maxEvents"
							aria-label="Listener event limit"
							type="number"
							min="1"
							max="1000"
							:disabled="!!eh.busy"
					/></label>
					<label
						>Time limit (seconds)<Input
							v-model.number="maxSeconds"
							aria-label="Listener time limit"
							type="number"
							min="1"
							max="3600"
							:disabled="!!eh.busy"
					/></label>
				</div>
				<p class="explorer-note">
					Receivers rotate through partitions when the partition count exceeds
					concurrency. The run stops at its shared limit or 64 MiB of bodies / 256 KiB of
					event summaries. Starting another read replaces retained event bodies. Export
					them first if needed.
				</p>
			</details>
			<div class="explorer-actions">
				<Button variant="outline" :disabled="!!eh.busy || !hub || !group" @click="load"
					>Load checkpoint…</Button
				><Button
					v-if="listener.result?.checkpoint"
					variant="outline"
					:disabled="!!eh.busy || listener.interrupted"
					@click="listener.saveCheckpoint"
					>Save checkpoint…</Button
				><Button
					v-if="listener.result?.checkpoint"
					variant="outline"
					:disabled="!!eh.busy"
					@click="resume"
					>Use result to resume</Button
				>
			</div>

			<p v-if="start === 'checkpoint' && listener.checkpoint" class="explorer-note">
				Checkpoint: {{ listener.checkpoint.hubName }} /
				{{ listener.checkpoint.consumerGroup }} ·
				{{ listener.checkpoint.partitions.length }} partitions ·
				{{ listener.checkpoint.savedAt }}. Each partition uses its reviewed starting
				position.
			</p>
			<label v-if="settingsOpen" class="check-row"
				><input v-model="acknowledged" type="checkbox" :disabled="!!eh.busy" />I reviewed
				the listener target, starting position and limits.</label
			>
			<p
				v-if="settingsOpen && acknowledged && !parsed.success"
				role="alert"
				class="error-banner"
			>
				{{ parsed.error.issues[0].message }}
			</p>
			<div class="explorer-actions">
				<Button
					v-if="settingsOpen"
					:disabled="
						!!eh.busy ||
						!parsed.success ||
						listener.interrupted ||
						!!listener.result?.cleanupWarning ||
						eh.connection?.access === 'send'
					"
					@click="run"
					>Start all-partition listener</Button
				><Button v-if="listener.running" variant="destructive" @click="eh.cancel"
					>Cancel {{ eh.serviceName }} listener</Button
				><Button
					v-if="listener.interrupted"
					variant="outline"
					:disabled="!!eh.busy"
					@click="listener.recover"
					>Recover listener result</Button
				>
			</div>
			<section
				v-if="listener.operationId"
				aria-label="Event Hubs listener results"
				class="listener-results"
			>
				<p v-if="listener.running" role="status">
					{{ received }} / {{ progress?.maxEvents ?? maxEvents }} events ·
					{{ progress?.activeReceivers ?? 0 }} active receivers ·
					{{ ((progress?.elapsedMs ?? 0) / 1000).toFixed(1) }} seconds ·
					{{ progress?.phase ?? 'starting' }}
				</p>
				<template v-if="listener.running && listener.job?.code"
					><p class="device-code">{{ listener.job.code }}</p>
					<Button variant="outline" @click="login" :disabled="false"
						>Open Microsoft sign-in</Button
					></template
				>
				<progress
					v-if="listener.running"
					aria-label="Event Hubs listener progress"
					:value="received"
					:max="progress?.maxEvents ?? maxEvents"
				/>
				<p v-if="listener.result" role="status">{{ listener.result.summary }}</p>
				<p v-if="listener.result" class="explorer-note">
					Result: {{ listener.result.hubName }} / {{ listener.result.consumerGroup }} ·
					{{ listener.result.status }} ·
					{{ (listener.result.elapsedMs / 1000).toFixed(1) }} seconds · Receipt
					{{ listener.result.operationId }}
				</p>
				<p v-if="listener.interrupted" class="inspector-warning">
					The final response is unavailable. Recover the retained result before saving a
					checkpoint or starting another listener.
				</p>
				<p v-if="listener.result?.cleanupWarning" class="inspector-warning">
					{{ listener.result.cleanupWarning }}
				</p>
				<EventOperationStatistics
					:statistics="listener.result?.statistics ?? progress?.statistics"
					:elapsed-ms="listener.result?.elapsedMs ?? progress?.elapsedMs ?? 0"
					label="Listener statistics"
				/>
				<div class="listener-table">
					<table class="property-table" aria-label="Listener partition progress">
						<thead>
							<tr>
								<th>Partition</th>
								<th>Status</th>
								<th>Events</th>
								<th>Bytes</th>
								<th>Events / second</th>
								<th>Last sequence</th>
								<th>Detail</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in rows" :key="row.partitionId">
								<td>{{ row.partitionId }}</td>
								<td>{{ row.status }}</td>
								<td>{{ row.received }}</td>
								<td>{{ row.bytes }}</td>
								<td>
									{{
										(listener.result?.elapsedMs ?? progress?.elapsedMs ?? 0) > 0
											? (
													(row.received * 1000) /
													(listener.result?.elapsedMs ??
														progress?.elapsedMs ??
														1)
												).toFixed(2)
											: '—'
									}}
								</td>
								<td>{{ row.lastSequence ?? '—' }}</td>
								<td>{{ row.error ?? '' }}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<Button
					v-if="listener.result?.items.length"
					variant="outline"
					:disabled="!!eh.busy"
					@click="
						listener.exportEvents(
							listener.result.items.flatMap((e) =>
								e.snapshotId ? [e.snapshotId] : [],
							),
						)
					"
					>Export listener events…</Button
				>
				<div v-if="listener.result?.items.length" class="listener-table">
					<table class="property-table" aria-label="Retained listener events">
						<thead>
							<tr>
								<th>Partition</th>
								<th>Sequence</th>
								<th>Enqueued</th>
								<th>Bytes</th>
								<th>Inspect</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="item in listener.result.items"
								:key="item.snapshotId ?? item.partitionId + item.sequenceNumber"
							>
								<td>{{ item.partitionId }}</td>
								<td>{{ item.sequenceNumber }}</td>
								<td>{{ item.enqueuedTime }}</td>
								<td>{{ item.bodySize }}</td>
								<td>
									<Button
										variant="ghost"
										:disabled="!!eh.busy || !item.snapshotId"
										:aria-label="`Inspect listener event ${item.partitionId} ${item.sequenceNumber}`"
										@click="inspect(item)"
										>Inspect</Button
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.listener-dialog {
	max-width: min(1150px, calc(100vw - 3rem));
}
.listener-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 0.8rem;
}
.listener-results {
	display: grid;
	gap: 0.8rem;
}
.listener-table {
	max-height: 250px;
	overflow: auto;
}
label {
	display: grid;
	gap: 0.3rem;
	font-size: 0.85rem;
}
.check-row {
	display: flex;
	align-items: flex-start;
	gap: 0.5rem;
}
select {
	padding: 0.5rem;
	border: 1px solid var(--border);
	border-radius: 0.4rem;
	background: var(--background);
	color: var(--foreground);
}
progress {
	width: 100%;
}
</style>
