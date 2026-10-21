<script setup lang="ts">
import { eventGridJob } from '@/features/event-grid/operation-progress'
import { eventGridApi } from '@/features/event-grid/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from '@/shared/ui/dialog'
import JsonBody from '../../../shared/components/JsonBody.vue'
import { prettyJson } from '@/shared/lib/message-body'
import { useEventGrid } from '@/features/event-grid/stores/event-grid'
import { useWorkspace } from '@/shared/workspace/store'
import {
	cloudEventJson,
	newCloudEvent,
	eventGridPublishSchema,
} from '@shared/contracts/event-grid/publishing'
const props = defineProps<{ topicName: string }>(),
	emit = defineEmits<{ close: [] }>(),
	grid = useEventGrid(),
	workspace = useWorkspace()
const mode = ref<'single' | 'batch'>('single'),
	drafts = ref([newCloudEvent()]),
	selected = ref(0),
	batchSize = ref(25),
	maxSeconds = ref(60),
	delayMs = ref(0),
	acknowledged = ref(false),
	error = ref(''),
	preview = ref(false)
const draft = computed(() => drafts.value[selected.value]),
	job = computed(() => eventGridJob(workspace.jobs.find((j) => j.id === grid.operationId)))
const receipt = computed(() =>
	grid.publishOutcome?.topicName === props.topicName ? grid.publishOutcome : undefined,
)
watch(
	[drafts, mode, batchSize, maxSeconds, delayMs],
	() => {
		acknowledged.value = false
		error.value = ''
	},
	{ deep: true },
)
function generateId() {
	draft.value.id = crypto.randomUUID()
}
function add() {
	if (drafts.value.length >= 100) return
	drafts.value.push(newCloudEvent())
	selected.value = drafts.value.length - 1
}
function remove() {
	if (drafts.value.length <= 1) return
	drafts.value.splice(selected.value, 1)
	selected.value = Math.min(selected.value, drafts.value.length - 1)
}
function close() {
	if (!grid.blocked) emit('close')
}
async function publish() {
	const value = {
		id: crypto.randomUUID(),
		connectionId: grid.connection?.connectionId,
		topicName: props.topicName,
		mode: mode.value,
		drafts: drafts.value,
		batchSize: batchSize.value,
		maxSeconds: maxSeconds.value,
		delayMs: delayMs.value,
		acknowledged: acknowledged.value,
	}
	const parsed = eventGridPublishSchema.safeParse(value)
	if (!parsed.success) {
		error.value = parsed.error.issues[0].message
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = parsed.data
	acknowledged.value = false
	await grid.publish(setup)
}
async function signIn() {
	const value = await eventGridApi.openDeviceLogin()
	if (!value.ok) error.value = value.error.message
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && close()">
		<DialogContent
			class="sm:max-w-[960px] eg-publisher"
			:show-close-button="false"
			@escape-key-down="grid.blocked && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Publish CloudEvents</DialogTitle
				><DialogDescription
					>{{ topicName }} · {{ grid.connection?.namespace }} · CloudEvents
					1.0</DialogDescription
				></DialogHeader
			>
			<div class="eg-publisher-scroll">
				<p class="field-hint">
					Entra publishing requires EventGrid Data Sender permission. Confirmation means
					Event Grid accepted the request; consumer delivery is separate. Limits: 100
					events and 512 KiB per job.
				</p>
				<fieldset :disabled="grid.blocked" class="eg-publish-fields">
					<div class="eg-publish-row">
						<label
							>Publishing mode<select v-model="mode" aria-label="Publishing mode">
								<option value="single">Single event</option>
								<option value="batch">Batch events</option>
							</select></label
						>
						<label v-if="mode === 'batch'"
							>Events per request<Input
								v-model.number="batchSize"
								type="number"
								min="1"
								max="100"
						/></label>
						<label
							>Time limit (seconds)<Input
								v-model.number="maxSeconds"
								type="number"
								min="1"
								max="300"
						/></label>
						<label v-if="mode === 'batch'"
							>Delay between requests (ms)<Input
								v-model.number="delayMs"
								type="number"
								min="0"
								max="1000"
						/></label>
					</div>
					<div v-if="mode === 'batch'" class="eg-publish-row">
						<label
							>Selected event<select
								v-model.number="selected"
								aria-label="Selected event"
							>
								<option v-for="(d, i) in drafts" :key="i" :value="i">
									{{ i + 1 }} · {{ d.id }}
								</option>
							</select></label
						>
						<Button variant="outline" :disabled="drafts.length >= 100" @click="add"
							>Add CloudEvent</Button
						>
						<Button variant="outline" :disabled="drafts.length <= 1" @click="remove"
							>Remove selected event</Button
						>
						<span>{{ drafts.length }} events</span>
					</div>
					<p v-if="mode === 'single' && drafts.length > 1" class="form-error">
						This draft contains {{ drafts.length }} events. Choose batch mode or remove
						extra events.
					</p>
					<div class="eg-publish-row">
						<label>Event ID<Input v-model="draft.id" /></label
						><Button variant="outline" @click="generateId">Generate event ID</Button>
					</div>
					<div class="eg-publish-row">
						<label
							>Event source<Input
								v-model="draft.source"
								placeholder="/orders" /></label
						><label
							>Event type<Input v-model="draft.type" placeholder="Order.Created"
						/></label>
					</div>
					<div class="eg-publish-row">
						<label>Event subject (optional)<Input v-model="draft.subject" /></label
						><label
							>Event time (optional)<Input
								v-model="draft.time"
								placeholder="RFC 3339 timestamp"
						/></label>
					</div>
					<div class="eg-publish-row">
						<label
							>Data content type (optional)<Input
								v-model="draft.dataContentType" /></label
						><label
							>Data schema (optional)<Input
								v-model="draft.dataSchema"
								placeholder="Absolute URI"
						/></label>
					</div>
					<label
						>Event data format<select
							v-model="draft.dataMode"
							aria-label="Event data format"
							@change="draft.data = ''"
						>
							<option value="json">JSON</option>
							<option value="text">Text</option>
							<option value="base64">Base64 binary</option>
							<option value="none">Omit data</option>
						</select></label
					>
					<label v-if="draft.dataMode !== 'none'"
						>Event data<textarea
							v-model="draft.data"
							rows="7"
							spellcheck="false"
							aria-label="Event data"
						/>
					</label>
					<div class="nh-actions">
						<h3>Extension properties</h3>
						<Button
							variant="outline"
							:disabled="draft.properties.length >= 32"
							@click="draft.properties.push({ name: '', type: 'string', value: '' })"
							>Add extension property</Button
						>
					</div>
					<div v-for="(p, i) in draft.properties" :key="i" class="eg-publish-row">
						<label>Extension name<Input v-model="p.name" /></label
						><label
							>Extension type<select v-model="p.type" aria-label="Extension type">
								<option value="string">String</option>
								<option value="boolean">Boolean</option>
								<option value="integer">Integer (32 bit)</option>
							</select></label
						><label>Extension value<Input v-model="p.value" /></label
						><Button variant="ghost" @click="draft.properties.splice(i, 1)"
							>Remove property</Button
						>
					</div>
					<p class="field-hint">
						Use unique lowercase extension names (letters and digits, up to 20
						characters). Each event needs a unique source and ID pair.
					</p>
					<Button variant="ghost" @click="preview = !preview">{{
						preview ? 'Hide event preview' : 'Preview selected event'
					}}</Button>
					<JsonBody
						v-if="preview"
						:text="prettyJson(cloudEventJson(draft)) ?? cloudEventJson(draft)"
					/>
				</fieldset>
				<section
					v-if="receipt"
					class="eg-publish-receipt"
					aria-label="CloudEvents publish receipt"
				>
					<strong>{{ receipt.status }}</strong>
					<p>{{ receipt.summary }}</p>
					<p>
						{{ receipt.confirmed }} confirmed · {{ receipt.uncertain }} uncertain ·
						{{ receipt.totalEvents - receipt.confirmed - receipt.uncertain }}
						unconfirmed / not attempted
					</p>
					<p class="field-hint">
						Receipt {{ receipt.operationId }} · {{ receipt.elapsedMs }} ms
					</p>
					<Button
						variant="outline"
						:disabled="grid.blocked"
						@click="grid.recoverPublish()"
						>Recover publish receipt</Button
					><label v-if="receipt.status === 'unknown'" class="eg-check"
						><input
							v-model="grid.publishReviewed"
							type="checkbox"
							:disabled="grid.blocked"
						/>
						I reviewed the uncertain send and possible duplicates before sending
						again.</label
					>
				</section>
			</div>
			<div v-if="grid.blocked" class="eg-publish-progress" role="status">
				<p>{{ job?.message ?? grid.busy }}</p>
				<progress
					v-if="job?.eventGridPublish"
					:value="job.eventGridPublish.confirmed"
					:max="job.eventGridPublish.totalEvents"
					aria-label="CloudEvents publishing progress"
				/><template v-if="job?.code"
					><p class="device-code">{{ job.code }}</p>
					<Button variant="outline" @click="signIn"
						>Open Microsoft sign-in</Button
					></template
				>
			</div>
			<p v-if="error || grid.error" class="form-error" role="alert">
				{{ error || grid.error }}
			</p>
			<DialogFooter class="eg-publish-footer"
				><label class="eg-check"
					><input v-model="acknowledged" type="checkbox" :disabled="grid.blocked" /> I
					understand publishing sends events to this topic.</label
				><Button v-if="grid.blocked" variant="outline" @click="grid.cancel()"
					>Cancel publishing</Button
				><Button :disabled="grid.writeBlocked || !acknowledged" @click="publish"
					>Publish {{ drafts.length }}
					{{ drafts.length === 1 ? 'event' : 'events' }}</Button
				><Button variant="outline" :disabled="grid.blocked" @click="close"
					>Close publisher</Button
				></DialogFooter
			>
		</DialogContent>
	</Dialog>
</template>
<style>
.eg-publisher {
	display: flex;
	flex-direction: column;
	max-height: 92vh;
	gap: 12px;
}
.eg-publisher-scroll {
	overflow-y: auto;
	min-height: 0;
	padding-right: 8px;
}
.eg-publish-fields {
	display: grid;
	gap: 12px;
	min-width: 0;
}
.eg-publish-fields label {
	display: grid;
	gap: 5px;
	flex: 1;
	min-width: 160px;
	font-size: 13px;
}
.eg-publish-row {
	display: flex;
	gap: 12px;
	align-items: end;
	flex-wrap: wrap;
}
.eg-publish-fields select,
.eg-publish-fields textarea {
	background: var(--background);
	color: var(--foreground);
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	width: 100%;
}
.eg-publish-fields textarea {
	font-family: monospace;
	resize: vertical;
}
.eg-publisher .body-preview {
	max-height: 300px;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.eg-publish-receipt {
	margin-top: 16px;
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow-wrap: anywhere;
}
.eg-publish-progress {
	flex-shrink: 0;
	font-size: 13px;
}
.eg-publisher progress {
	width: 100%;
}
.eg-publish-footer {
	flex-wrap: wrap;
	align-items: center;
	flex-shrink: 0;
	gap: 8px;
}
.eg-publish-footer label {
	flex: 1;
	font-size: 12px;
}
.eg-publisher .eg-check {
	display: flex;
	gap: 8px;
	align-items: center;
}
</style>
