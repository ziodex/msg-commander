<script setup lang="ts">
import { eventHubsApi } from '@/features/event-hubs/api'

import { ref, watch, onBeforeUnmount } from 'vue'
import { Button } from '@/shared/ui/button'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventListener } from '@/features/event-hubs/stores/event-hubs-listener'
import type { EventImportPreview, EventImport } from '@shared/contracts/event-hubs/files'
import type { EventDraft } from '@shared/contracts/event-hubs/sending'
const props = defineProps<{ disabled: boolean }>(),
	emit = defineEmits<{ loaded: [drafts: EventDraft[]] }>(),
	eh = useEventHubs(),
	files = useEventListener()
const visible = ref(false),
	format = ref<EventImport['format']>('archive'),
	mode = ref<'full' | 'body'>('full'),
	preview = ref<EventImportPreview>(),
	selected = ref<string[]>([])
async function discard() {
	const value = preview.value
	preview.value = undefined
	selected.value = []
	if (value?.importId && eh.connection)
		await eventHubsApi.discardImportedEvents({
			id: crypto.randomUUID(),
			connectionId: eh.connection.connectionId,
			importId: value.importId,
		})
}
watch(format, () => {
	void discard()
})
watch(mode, () => {
	selected.value = []
})
watch(
	() => eh.connection?.connectionId,
	() => {
		preview.value = undefined
		selected.value = []
		visible.value = false
	},
)
onBeforeUnmount(() => {
	void discard()
})
async function choose() {
	await discard()
	const value = await files.task('Import Event Hubs files', (id, connectionId) =>
		eventHubsApi.importEvents({ id, connectionId, format: format.value }),
	)
	if (value && !value.cancelled) {
		preview.value = value
		selected.value = []
	}
}
async function load() {
	if (!preview.value?.importId) return
	const importId = preview.value.importId
	const value = await files.task('Load event drafts', (id, connectionId) =>
		eventHubsApi.loadImportedEvents({
			id,
			connectionId,
			importId,
			entryIds: [...selected.value],
			mode: mode.value,
		}),
	)
	if (value) {
		emit('loaded', value.drafts)
		await discard()
		visible.value = false
	}
}
</script>
<template>
	<div class="event-import-panel">
		<Button variant="outline" :disabled="disabled || !!eh.busy" @click="visible = !visible"
			>Import event files…</Button
		>
		<section v-if="visible" aria-label="Import Event Hubs files">
			<p class="explorer-note">
				Choose an Event Hubs archive or raw body files. Loading replaces the current drafts
				after your review. Original sequence, offset, enqueue time, message ID and partition
				key remain archive metadata; sending uses new IDs and the composer's selected
				routing. No events are published by importing.
			</p>
			<div class="explorer-actions">
				<label
					>File format<select
						v-model="format"
						aria-label="Event import format"
						:disabled="!!eh.busy"
					>
						<option value="archive">Commander Event Hubs archive</option>

						<option value="body">Raw body files</option>
					</select></label
				><Button variant="outline" :disabled="disabled || !!eh.busy" @click="choose"
					>Choose event files…</Button
				>
			</div>

			<template v-if="preview?.items.length">
				<label
					>Draft content<select
						v-model="mode"
						aria-label="Event import mode"
						:disabled="!!eh.busy"
					>
						<option value="full">Body and application properties</option>
						<option value="body">Body only (discard archive metadata)</option>
					</select></label
				>
				<p>Select up to 20 events and 512 KiB of serialized drafts.</p>
				<div class="event-import-table">
					<table class="property-table" aria-label="Event import preview">
						<thead>
							<tr>
								<th>Select</th>
								<th>File / event</th>
								<th>Body bytes</th>
								<th>Source</th>
								<th>Issue</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="item in preview.items" :key="item.id">
								<td>
									<input
										v-model="selected"
										type="checkbox"
										:value="item.id"
										:aria-label="`Import event ${item.index} from ${item.fileName}`"
										:disabled="
											!!eh.busy ||
											!!(mode === 'full' ? item.fullIssue : item.bodyIssue)
										"
									/>
								</td>
								<td>{{ item.fileName }} · {{ item.index }}</td>
								<td>{{ item.bodySize }}</td>
								<td>
									{{
										item.source
											? `${item.source.hubName} / ${item.source.partitionId}`
											: 'Body / draft'
									}}
								</td>
								<td>{{ mode === 'full' ? item.fullIssue : item.bodyIssue }}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<details
					v-if="preview.items.some((item) => item.warnings?.length)"
					open
					class="event-import-notes"
				>
					<summary>Import notes</summary>
					<div
						v-for="item in preview.items.filter((entry) => entry.warnings?.length)"
						:key="item.id"
					>
						<strong>{{ item.fileName }} · {{ item.index }}</strong>
						<p v-for="warning in item.warnings" :key="warning" class="explorer-note">
							{{ warning }}
						</p>
					</div>
				</details>
				<Button
					:disabled="
						disabled || !!eh.busy || selected.length === 0 || selected.length > 20
					"
					@click="load"
					>Replace drafts with selected events</Button
				>
			</template>
		</section>
	</div>
</template>
<style scoped>
.event-import-panel,
section {
	display: grid;
	gap: 0.8rem;
}
.event-import-table {
	max-height: 240px;
	overflow: auto;
}
.event-import-notes {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px;
	font-size: 12px;
}
.event-import-notes summary {
	cursor: pointer;
	margin-bottom: 8px;
	font-weight: 600;
}
.event-import-notes > div + div {
	margin-top: 12px;
}
.event-import-notes p {
	margin-top: 4px;
	overflow-wrap: anywhere;
}
label {
	display: grid;
	gap: 0.3rem;
}
select {
	padding: 0.5rem;
	background: var(--background);
	color: var(--foreground);
	border: 1px solid var(--border);
	border-radius: 0.4rem;
}
</style>
