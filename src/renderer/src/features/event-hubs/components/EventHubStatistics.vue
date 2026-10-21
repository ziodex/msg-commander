<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
const eh = useEventHubs(),
	visible = ref(false),
	hubName = ref(''),
	interval = ref('0')
const snapshot = computed(() =>
	eh.statistics?.hub.name === hubName.value ? eh.statistics : undefined,
)
let timer: ReturnType<typeof setInterval> | undefined
watch([visible, interval], () => {
	clearInterval(timer)
	if (visible.value && interval.value !== '0')
		timer = setInterval(
			() => {
				if (!eh.busy) void eh.refreshStatistics(hubName.value)
			},
			Number(interval.value) * 1000,
		)
})
watch(
	() => eh.connection?.connectionId,
	() => {
		visible.value = false
		interval.value = '0'
	},
)
onBeforeUnmount(() => clearInterval(timer))
function open(name = eh.hubName) {
	hubName.value = name
	visible.value = true
	void eh.refreshStatistics(name)
}
defineExpose({ open })
</script>
<template>
	<Dialog :open="visible" @update:open="visible = $event"
		><DialogContent class="event-hub-statistics-dialog">
			<DialogHeader
				><DialogTitle>Event Hub statistics · {{ hubName }}</DialogTitle
				><DialogDescription
					>{{ eh.connection?.namespace }}. Partition metadata only; no receiver or
					checkpoint writes.</DialogDescription
				></DialogHeader
			>
			<div class="event-hub-statistics-scroll">
				<p v-if="eh.error" role="alert" class="error-banner">{{ eh.error }}</p>
				<p v-if="eh.urlNotice" role="status">{{ eh.urlNotice }}</p>
				<p v-if="snapshot">
					{{ snapshot.partitions.length }} partitions ·
					{{ snapshot.partitions.filter((p) => p.metadata?.isEmpty).length }} empty ·
					{{ snapshot.partitions.filter((p) => p.error).length }} unavailable
				</p>
				<p v-if="snapshot" class="explorer-note">
					Snapshot {{ snapshot.startedAt }} – {{ snapshot.capturedAt }}. Partitions are
					queried separately; this is not an atomic snapshot. A failed or cancelled
					refresh leaves this timestamp unchanged.
				</p>
				<p class="explorer-note">
					Sequence numbers describe retained stream positions. They are not a queue depth
					or an unread count for this consumer group. Namespace-wide Azure Monitor metrics
					are not included.
				</p>
				<div class="event-hub-statistics-table">
					<table
						v-if="snapshot"
						class="property-table"
						aria-label="Event Hub partition statistics"
					>
						<thead>
							<tr>
								<th>Partition</th>
								<th>State</th>
								<th>Beginning sequence</th>
								<th>Last sequence</th>
								<th>Last offset</th>
								<th>Last enqueued</th>
								<th>URL</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in snapshot.partitions" :key="row.partitionId">
								<td>{{ row.partitionId }}</td>
								<td>
									{{
										row.error ??
										(row.metadata?.isEmpty ? 'Empty' : 'Retained stream')
									}}
								</td>
								<td>{{ row.metadata?.beginningSequence ?? '—' }}</td>
								<td>{{ row.metadata?.lastSequence ?? '—' }}</td>
								<td>{{ row.metadata?.lastOffset ?? '—' }}</td>
								<td>{{ row.metadata?.lastEnqueuedTime ?? '—' }}</td>
								<td>
									<Button
										variant="ghost"
										size="sm"
										:disabled="!!eh.busy"
										:aria-label="`Copy partition ${row.partitionId} URL`"
										@click="
											eh.copyUrl({
												kind: 'partition',
												hubName,
												consumerGroup: eh.consumerGroup,
												partitionId: row.partitionId,
											})
										"
										>Copy HTTPS URL</Button
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
			<div class="explorer-actions">
				<label
					>Auto refresh
					<select v-model="interval" aria-label="Event Hub statistics refresh interval">
						<option value="0">Off</option>
						<option value="15">15 seconds</option>
						<option value="30">30 seconds</option>
						<option value="60">60 seconds</option>
					</select></label
				>
				<Button
					variant="outline"
					:disabled="!!eh.busy"
					@click="eh.refreshStatistics(hubName)"
					>Refresh statistics</Button
				>
				<Button
					v-if="eh.busy === 'Refresh Event Hub statistics'"
					variant="outline"
					@click="eh.cancel"
					>Cancel statistics refresh</Button
				>
				<Button
					variant="outline"
					:disabled="!!eh.busy"
					@click="eh.copyUrl({ kind: 'hub', hubName })"
					>Copy hub HTTPS URL</Button
				>
				<span v-if="eh.busy === 'Refresh Event Hub statistics'" role="status"
					>Refreshing partitions…</span
				>
			</div>
		</DialogContent></Dialog
	>
</template>
<style>
.event-hub-statistics-dialog {
	width: min(1200px, calc(100vw - 3rem));
	max-width: min(1200px, calc(100vw - 3rem));
	max-height: 90vh;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.event-hub-statistics-scroll {
	min-height: 0;
	overflow: auto;
}
.event-hub-statistics-table {
	overflow: auto;
}
.event-hub-statistics-dialog .explorer-actions {
	flex-shrink: 0;
	flex-wrap: wrap;
}
.event-hub-statistics-dialog label {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}
</style>
