<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import { useNotificationHubRegistrations } from '@/features/notification-hubs/stores/notification-hub-registrations'
import { useWorkspace } from '@/shared/workspace/store'
const props = defineProps<{ snapshotIds: string[]; initialTab: 'import' | 'export' | 'results' }>()
const emit = defineEmits<{ close: [] }>()
const registrations = useNotificationHubRegistrations(),
	workspace = useWorkspace()
const tab = ref(props.initialTab),
	format = ref<'json' | 'xml'>('json'),
	selected = ref<string[]>([]),
	ack = ref(false),
	saved = ref('')
const xmlReview = ref<HTMLElement>()
const reviewedEntry = computed(() =>
	registrations.filePreview?.entries.find(
		(entry) => entry.id === registrations.fileDetails?.entryId,
	),
)
async function inspect(entryId: string) {
	await registrations.inspectFile(entryId)
	await nextTick()
	xmlReview.value?.scrollIntoView({ block: 'nearest' })
}
const progress = computed(() => workspace.jobs.find((job) => job.id === registrations.operationId))
watch(
	() => registrations.filePreview,
	(value) => {
		selected.value =
			value?.entries.filter((entry) => entry.action === 'create').map((entry) => entry.id) ??
			[]
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
async function load() {
	const value = await registrations.importFile()
	if (value && !value.cancelled) tab.value = 'import'
}
async function apply() {
	if (!ack.value) return
	if (await registrations.applyFile([...selected.value])) {
		ack.value = false
		tab.value = 'results'
	}
}
async function save() {
	saved.value = ''
	const value = await registrations.exportFile([...props.snapshotIds], format.value)
	if (value && !value.cancelled)
		saved.value = `Saved ${value.count} registration snapshots to ${value.fileName}.`
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !registrations.busy && emit('close')">
		<DialogContent
			class="sm:max-w-[960px] nh-registration-files"
			:show-close-button="false"
			@escape-key-down="registrations.busy && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Registration files</DialogTitle
				><DialogDescription
					>{{ registrations.connection?.namespace }} ·
					{{ registrations.connection?.hubName }} · Save snapshots or import reviewed
					copies.</DialogDescription
				></DialogHeader
			>
			<div class="nh-actions" role="tablist" aria-label="Registration file views">
				<Button
					v-for="item in ['import', 'export', 'results'] as const"
					:key="item"
					role="tab"
					:aria-selected="tab === item"
					:variant="tab === item ? 'default' : 'outline'"
					:disabled="!!registrations.busy"
					@click="tab = item"
					>{{
						item === 'import' ? 'Import' : item === 'export' ? 'Export' : 'Results'
					}}</Button
				>
			</div>
			<div class="nh-registration-files-scroll">
				<template v-if="tab === 'export'">
					<p>
						Export {{ snapshotIds.length }} selected registration snapshots from the
						current page or inspector.
					</p>
					<label class="nh-config-format"
						>Registration file format<select
							v-model="format"
							:disabled="!!registrations.busy"
							aria-label="Registration file format"
						>
							<option value="json">Commander JSON archive</option>
							<option value="xml">Azure registration XML (Atom feed)</option>
						</select></label
					>
					<p class="form-warning">
						Files contain device handles, tags, templates and extension fields. Store
						them securely. SAS keys and provider credentials are excluded.
					</p>
					<p class="field-hint">
						This saves the captured snapshots, including their IDs, ETags and expiration
						metadata. It does not enumerate the whole hub or refresh Azure. Refresh the
						page first if you need newer data.
					</p>
					<Button :disabled="!!registrations.busy || !snapshotIds.length" @click="save"
						>Save registration file…</Button
					>
					<p v-if="saved" role="status">{{ saved }}</p>
				</template>
				<template v-else-if="tab === 'import'">
					<p>
						Choose a Commander JSON archive or Azure registration XML: a single
						description, Atom entry or Atom feed. Files are limited to 100 registrations
						and 512 KiB.
					</p>
					<Button variant="outline" :disabled="!!registrations.busy" @click="load"
						>Choose registration file…</Button
					>
					<template v-if="registrations.filePreview">
						<div class="nh-config-destination">
							<strong>{{ registrations.fileName }}</strong>
							<p>
								Source: {{ registrations.filePreview.sourceNamespace }} /
								{{ registrations.filePreview.sourceHub }}
							</p>
							<p>
								Destination: {{ registrations.filePreview.destinationNamespace }} /
								{{ registrations.filePreview.destinationHub }}
							</p>
							<small
								>Preview expires
								{{
									new Date(
										registrations.filePreview.expiresAt,
									).toLocaleTimeString()
								}}.</small
							>
						</div>
						<p class="form-warning">
							Import creates new registrations with new Azure IDs. Importing an
							existing device handle can create a duplicate. Nothing is updated or
							deleted; source IDs, ETags and expiration are not sent.
						</p>
						<details class="nh-config-notes">
							<summary>Import behavior and file safety</summary>
							<p v-for="warning in registrations.filePreview.warnings" :key="warning">
								{{ warning }}
							</p>
							<p>
								Imports stop at the first failed, cancelled or uncertain write, or
								after two minutes. Confirmed copies stay applied. Unsupported
								definitions remain inspectable but cannot be imported.
							</p>
						</details>
						<div class="nh-actions">
							<Button
								size="sm"
								variant="ghost"
								:disabled="!!registrations.busy"
								@click="
									selected = registrations.filePreview.entries
										.filter((e) => e.action === 'create')
										.map((e) => e.id)
								"
								>Select importable registrations</Button
							><Button
								size="sm"
								variant="ghost"
								:disabled="!!registrations.busy"
								@click="selected = []"
								>Clear import selection</Button
							><span>{{ selected.length }} selected</span>
						</div>
						<div class="nh-registration-table-wrap">
							<table class="nh-policy-table nh-registration-file-table">
								<thead>
									<tr>
										<th>Select</th>
										<th>Source registration</th>
										<th>Tags / device handle</th>
										<th>Proposed change</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="(entry, index) in registrations.filePreview.entries"
										:key="entry.id"
									>
										<td>
											<input
												v-model="selected"
												type="checkbox"
												:value="entry.id"
												:aria-label="`Import registration ${index + 1}`"
												:disabled="
													!!registrations.busy ||
													entry.action === 'blocked'
												"
											/>
										</td>
										<td>
											{{ entry.registrationId ?? `Entry ${index + 1}`
											}}<small
												>{{ entry.platform }} ·
												{{ entry.template ? 'Template' : 'Native' }}</small
											><Button
												size="sm"
												variant="ghost"
												:disabled="!!registrations.busy"
												@click="inspect(entry.id)"
												>Review XML {{ index + 1 }}</Button
											>
										</td>
										<td>
											{{ entry.tags.join(', ') || 'No tags'
											}}<small class="nh-device-handle">{{
												entry.handle ?? 'See XML'
											}}</small>
										</td>
										<td>
											{{
												entry.action === 'create'
													? 'Create with new ID'
													: 'Blocked'
											}}
											<p v-if="entry.issue" class="form-warning">
												{{ entry.issue }}
											</p>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
						<section
							v-if="registrations.fileDetails"
							aria-label="Imported registration XML"
							ref="xmlReview"
						>
							<h3>
								Reviewed definition ·
								{{ reviewedEntry?.registrationId ?? reviewedEntry?.platform }}
								(read-only metadata removed)
							</h3>
							<Button
								size="sm"
								variant="ghost"
								:disabled="!!registrations.busy"
								@click="registrations.fileDetails = undefined"
								>Close XML review</Button
							>
							<pre class="body-preview">{{ registrations.fileDetails.rawXml }}</pre>
						</section>
						<label class="checkbox-label"
							><input
								v-model="ack"
								type="checkbox"
								:disabled="registrations.blocked || !selected.length"
							/>I reviewed the destination and selected registrations, and understand
							new copies may duplicate existing device handles.</label
						>
						<Button
							:disabled="registrations.blocked || !ack || !selected.length"
							@click="apply"
							>Create selected registration copies</Button
						>
					</template>
				</template>
				<template v-else>
					<template v-if="registrations.fileOutcome"
						><p role="status">{{ registrations.fileOutcome.summary }}</p>
						<small>Receipt: {{ registrations.fileOutcome.operationId }}</small>
						<table class="nh-policy-table">
							<thead>
								<tr>
									<th>Selected entry</th>
									<th>Result</th>
									<th>New registration ID</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="(step, index) in registrations.fileOutcome.steps"
									:key="step.entryId"
								>
									<td>{{ index + 1 }}</td>
									<td>
										{{ step.status }}
										<p v-if="step.receipt">{{ step.receipt.summary }}</p>
									</td>
									<td>
										{{
											step.receipt?.registrationId ?? 'Not assigned / unknown'
										}}
									</td>
								</tr>
							</tbody>
						</table>
						<Button
							variant="outline"
							:disabled="!!registrations.busy"
							@click="registrations.recoverFile()"
							>Check retained registration import receipt</Button
						>
						<label
							v-if="registrations.fileOutcome.status === 'unknown'"
							class="checkbox-label"
							><input
								v-model="registrations.fileReviewed"
								type="checkbox"
								:disabled="!!registrations.busy"
							/>I checked Azure state and reviewed the uncertain registration import
							before another write.</label
						>
					</template>
					<p v-else>No registration imports yet.</p>
				</template>
				<p v-if="registrations.error" class="form-error" role="alert">
					{{ registrations.error }}
				</p>
			</div>
			<DialogFooter
				><template v-if="registrations.busy"
					><div role="status">
						<p>{{ registrations.busy }}…</p>
						<p>{{ progress?.message }}</p>
						<progress
							v-if="progress?.percent !== undefined"
							aria-label="Registration import progress"
							:value="progress.percent"
							max="100"
						/>
					</div>
					<Button variant="outline" @click="registrations.cancel()"
						>Cancel registration file operation</Button
					></template
				><Button variant="outline" :disabled="!!registrations.busy" @click="emit('close')"
					>Close registration files</Button
				></DialogFooter
			>
		</DialogContent>
	</Dialog>
</template>
<style>
.nh-registration-files {
	display: flex;
	flex-direction: column;
	max-height: 90vh;
	gap: 16px;
}
.nh-registration-files-scroll {
	overflow: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding-right: 4px;
}
.nh-registration-files-scroll > button {
	align-self: flex-start;
}
.nh-registration-file-table {
	min-width: 700px;
	table-layout: fixed;
}
.nh-registration-file-table th:first-child {
	width: 60px;
}
.nh-registration-file-table td {
	vertical-align: top;
	overflow-wrap: anywhere;
}
.nh-registration-file-table small {
	display: block;
	color: var(--muted-foreground);
	margin-top: 4px;
}
.nh-registration-files pre {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 320px;
	overflow: auto;
	font-size: 11px;
}

.nh-registration-files-scroll > * {
	flex-shrink: 0;
}
.nh-registration-files-scroll > .nh-registration-table-wrap {
	max-height: 360px;
}
</style>
