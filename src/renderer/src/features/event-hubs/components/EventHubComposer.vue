<script setup lang="ts">
import { eventHubsApi } from '@/features/event-hubs/api'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
import EventImportPanel from './EventImportPanel.vue'
import { BodyCodecTools } from '@/features/body-tools'
import { useEventListener } from '@/features/event-hubs/stores/event-hubs-listener'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { decodeBase64, utf8Preview } from '@/shared/lib/message-body'
import { composerBody } from '@/shared/lib/composer'
import {
	eventDraftSchema,
	eventHubSendSchema,
	eventPropertySchema,
	type EventDraft,
	type EventRouting,
} from '@shared/contracts/event-hubs/sending'
const eh = useEventHubs(),
	eventFiles = useEventListener()
const visible = ref(false),
	source = ref(''),
	index = ref(0),
	acknowledged = ref(false),
	reviewed = ref(false)
const routingKind = ref<'automatic' | 'partition' | 'key'>('automatic'),
	routingValue = ref('')
const repetitions = ref(1),
	batchSize = ref(100),
	maxSeconds = ref(30),
	delayMs = ref(0)
type Editor = {
	encoding: 'text' | 'json' | 'base64'
	body: string
	contentType: string
	correlationId: string
	properties: EventDraft['properties']
}
const fresh = (): Editor => ({
	encoding: 'json',
	body: '{\n  "message": "Hello from Commander"\n}',
	contentType: 'application/json',
	correlationId: '',
	properties: [],
})
function useCodecBody(value: string) {
	current.value.encoding = 'base64'
	current.value.body = value
}
const drafts = ref<Editor[]>([fresh()]),
	current = computed(() => drafts.value[index.value]!)
const codecSource = computed(() => {
	try {
		return composerBody(current.value.body, current.value.encoding).base64
	} catch {
		return undefined
	}
})
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
watch(
	() => eh.sending,
	(active) => {
		clearInterval(timer)
		if (active) {
			const start = Date.now()
			elapsed.value = 0
			timer = setInterval(() => {
				elapsed.value = Date.now() - start
			}, 250)
		}
	},
	{ immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))
watch(
	() => eh.connection?.connectionId,
	() => {
		visible.value = false
		acknowledged.value = reviewed.value = false
		source.value = ''
		drafts.value = [fresh()]
		index.value = 0
	},
)
watch(
	[drafts, source, routingKind, routingValue, repetitions, batchSize, maxSeconds, delayMs],
	() => {
		acknowledged.value = false
	},
	{ deep: true, flush: 'sync' },
)
const converted = computed(() => {
	try {
		const values = drafts.value.map((draft, i) => {
			const body = composerBody(draft.body, draft.encoding)
			const value = eventDraftSchema.safeParse({
				bodyBase64: body.base64,
				contentType: draft.contentType,
				correlationId: draft.correlationId,
				properties: draft.properties,
			})
			if (!value.success) throw new Error(`Draft ${i + 1}: ${value.error.issues[0].message}`)
			return value.data
		})
		return { values, error: '' }
	} catch (cause) {
		return {
			values: [] as EventDraft[],
			error: cause instanceof Error ? cause.message : 'Invalid event draft.',
		}
	}
})
const routing = computed((): EventRouting =>
	routingKind.value === 'automatic'
		? { kind: 'automatic' }
		: { kind: routingKind.value, value: routingValue.value },
)
const input = computed(() => ({
	hubName: source.value,
	drafts: converted.value.values,
	routing: routing.value,
	repetitions: repetitions.value,
	batchSize: batchSize.value,
	maxSeconds: maxSeconds.value,
	delayMs: delayMs.value,
	acknowledged: acknowledged.value,
}))
const parsed = computed(() =>
	eventHubSendSchema.safeParse({
		...input.value,
		id: crypto.randomUUID(),
		connectionId: eh.connection?.connectionId,
	}),
)
const blocked = computed(() => !!eh.busy || !!eh.sendId)
const progress = computed(() => eh.sendJob?.eventHubSend)
const total = computed(
	() =>
		eh.sendResult?.totalEvents ??
		progress.value?.totalEvents ??
		drafts.value.length * repetitions.value,
)
const confirmed = computed(() => eh.sendResult?.confirmed ?? progress.value?.confirmed ?? 0)
const duration = computed(
	() => eh.sendResult?.elapsedMs ?? Math.max(elapsed.value, progress.value?.elapsedMs ?? 0),
)
const mustReview = computed(() => !!eh.sendResult?.uncertain)
function open() {
	if (!eh.connection || (eh.busy && !eh.sending)) return
	if (!eh.sendId) {
		source.value = eh.hubName
		acknowledged.value = false
	}
	visible.value = true
}
function prepare() {
	if (
		eh.busy ||
		eh.sendInterrupted ||
		eh.sendResult?.cleanupWarning ||
		(mustReview.value && !reviewed.value)
	)
		return
	eh.clearSend()
	source.value = eh.hubName
	acknowledged.value = reviewed.value = false
	elapsed.value = 0
}
function addDraft() {
	if (drafts.value.length < 20) {
		drafts.value.push(fresh())
		index.value = drafts.value.length - 1
	}
}
function removeDraft(i: number) {
	if (drafts.value.length > 1) {
		drafts.value.splice(i, 1)
		index.value = Math.min(index.value, drafts.value.length - 1)
	}
}
async function send() {
	if (!parsed.value.success || blocked.value || !eh.connection) return
	await eh.send(parsed.value.data)
}
async function signIn() {
	await eventHubsApi.openDeviceLogin()
}
function close(value: boolean) {
	if (!eh.sending) visible.value = value
}
function imported(values: EventDraft[]) {
	if (blocked.value) return
	drafts.value = values.map((value) => {
		const bytes = decodeBase64(value.bodyBase64),
			text = utf8Preview(bytes, true),
			encoded = text === null ? null : new TextEncoder().encode(text)
		const readable =
			text !== null &&
			encoded?.length === bytes.length &&
			encoded.every((byte, i) => byte === bytes[i]) &&
			!bytes.includes(0)
		return {
			encoding: readable ? 'text' : 'base64',
			body: readable ? text : value.bodyBase64,
			contentType: value.contentType,
			correlationId: value.correlationId,
			properties: value.properties,
		}
	})
	index.value = 0
	acknowledged.value = false
}
async function saveDrafts() {
	if (converted.value.error) return
	const value = await eventFiles.task('Save Event Hubs drafts', (id, connectionId) =>
		eventHubsApi.saveEventDrafts({ id, connectionId, drafts: converted.value.values }),
	)
	if (value && !value.cancelled)
		eventFiles.notice = `Saved ${value.count} drafts to ${value.fileName}.`
}
defineExpose({ open })
</script>
<template>
	<Dialog :open="visible" @update:open="close"
		><DialogContent
			class="message-inspection-dialog event-send-dialog"
			:show-close-button="!eh.sending"
			@escape-key-down="eh.sending && $event.preventDefault()"
			@interact-outside="eh.sending && $event.preventDefault()"
			><DialogHeader
				><DialogTitle>Send Event Hubs events</DialogTitle
				><DialogDescription
					>{{ eh.connection?.namespace }} / {{ eh.sendResult?.hubName ?? source }}. Review
					drafts, routing and the total event count before publishing.</DialogDescription
				></DialogHeader
			>
			<p v-if="eh.error" class="error-banner" role="alert">{{ eh.error }}</p>
			<p v-if="eventFiles.notice" role="status">{{ eventFiles.notice }}</p>
			<template v-if="!eh.sendId">
				<EventImportPanel :disabled="blocked" @loaded="imported" />

				<Button
					variant="outline"
					:disabled="blocked || !!converted.error"
					@click="saveDrafts"
					>Save event drafts…</Button
				>
				<div class="send-editor-layout">
					<aside class="draft-list" aria-label="Event drafts">
						<div v-for="(_draft, i) in drafts" :key="i">
							<Button
								variant="ghost"
								:aria-pressed="index === i"
								:aria-label="`Event draft ${i + 1}`"
								:disabled="blocked"
								@click="index = i"
								>Event {{ i + 1 }}</Button
							><Button
								variant="ghost"
								:aria-label="`Remove event draft ${i + 1}`"
								:disabled="blocked || drafts.length === 1"
								@click="removeDraft(i)"
								>×</Button
							>
						</div>
						<Button
							variant="outline"
							size="sm"
							:disabled="blocked || drafts.length >= 20"
							@click="addDraft"
							>Add event draft</Button
						>
					</aside>
					<div class="draft-editor">
						<div class="send-fields">
							<label
								>Body format<select
									v-model="current.encoding"
									aria-label="Event body format"
									:disabled="blocked"
								>
									<option value="text">Text</option>
									<option value="json">JSON</option>
									<option value="base64">Binary (base64)</option>
								</select></label
							><label
								>Content type<Input
									v-model="current.contentType"
									aria-label="Event content type"
									maxlength="128"
									:disabled="blocked" /></label
							><label
								>Correlation ID<Input
									v-model="current.correlationId"
									aria-label="Event correlation ID"
									maxlength="128"
									:disabled="blocked"
							/></label>
						</div>
						<label
							>Event body<textarea
								v-model="current.body"
								aria-label="Event body"
								class="event-body-input mono"
								rows="6"
								maxlength="349528"
								:disabled="blocked"
							/>
						</label>

						<BodyCodecTools
							:base64="codecSource"
							:source-key="String(index)"
							:disabled="blocked || codecSource === undefined"
							allow-apply
							@apply="useCodecBody"
						/>
						<details>
							<summary>
								Application properties ({{ current.properties.length }})
							</summary>
							<div
								v-for="(property, p) in current.properties"
								:key="p"
								class="property-editor"
							>
								<Input
									v-model="property.name"
									:aria-label="`Event property ${p + 1} name`"
									placeholder="Name"
									maxlength="128"
									:disabled="blocked"
								/><select
									v-model="property.type"
									:aria-label="`Event property ${p + 1} type`"
									:disabled="blocked"
								>
									<option
										v-for="kind in eventPropertySchema.shape.type.options"
										:key="kind"
										:value="kind"
									>
										{{ kind }}
									</option></select
								><Input
									v-model="property.value"
									:aria-label="`Event property ${p + 1} value`"
									placeholder="Value"
									maxlength="4096"
									:disabled="blocked"
								/><Button
									variant="ghost"
									:aria-label="`Remove event property ${p + 1}`"
									:disabled="blocked"
									@click="current.properties.splice(p, 1)"
									>×</Button
								>
							</div>
							<Button
								variant="outline"
								size="sm"
								:disabled="blocked || current.properties.length >= 32"
								@click="
									current.properties.push({ name: '', type: 'string', value: '' })
								"
								>Add event property</Button
							>
						</details>
					</div>
				</div>
				<div class="send-fields">
					<label
						>Routing<select
							v-model="routingKind"
							aria-label="Event send routing"
							:disabled="blocked"
						>
							<option value="automatic">Automatic partition</option>
							<option value="key">Partition key</option>
							<option value="partition">Specific partition</option>
						</select></label
					><label v-if="routingKind !== 'automatic'"
						>{{ routingKind === 'key' ? 'Partition key' : 'Partition ID'
						}}<Input
							v-model="routingValue"
							aria-label="Event routing value"
							maxlength="128"
							:disabled="blocked"
							:placeholder="
								routingKind === 'partition'
									? eh.partitionId || '0'
									: 'e.g. device-42'
							"
					/></label>
				</div>
				<div class="send-fields">
					<label
						>Repeat draft list<Input
							v-model.number="repetitions"
							aria-label="Event send repetitions"
							type="number"
							min="1"
							max="1000"
							:disabled="blocked" /></label
					><label
						>Maximum events per batch<Input
							v-model.number="batchSize"
							aria-label="Event send batch size"
							type="number"
							min="1"
							max="100"
							:disabled="blocked" /></label
					><label
						>Time limit (seconds)<Input
							v-model.number="maxSeconds"
							aria-label="Event send time limit"
							type="number"
							min="1"
							max="300"
							:disabled="blocked" /></label
					><label
						>Delay between batches (ms)<Input
							v-model.number="delayMs"
							aria-label="Event send delay"
							type="number"
							min="0"
							max="1000"
							:disabled="blocked"
					/></label>
				</div>
				<p class="explorer-note">
					{{ drafts.length }} drafts × {{ repetitions }} = {{ total }} events (maximum
					1,000). Batch sizes also depend on the broker’s byte limit. Event IDs are
					generated per send and event index; they do not prevent duplicates.
				</p>
				<p v-if="converted.error" role="alert" class="error-banner">
					{{ converted.error }}
				</p>
				<p v-else-if="!parsed.success && acknowledged" role="alert" class="error-banner">
					{{ parsed.error.issues[0].message }}
				</p>
				<label class="check-row"
					><input v-model="acknowledged" type="checkbox" :disabled="blocked" />I
					understand this publishes {{ total }} events to {{ source }}.</label
				>
				<Button :disabled="blocked || !parsed.success" @click="send">Send events</Button>
			</template>
			<section v-else aria-label="Event send result" class="send-receipt">
				<p v-if="eh.sending" role="status">
					{{ confirmed }} / {{ total }} events confirmed ·
					{{ progress?.phase ?? 'starting' }} · {{ (duration / 1000).toFixed(1) }}s
				</p>
				<progress :value="confirmed" :max="total" aria-label="Event send progress" />
				<template v-if="eh.sendJob?.code"
					><p class="device-code">{{ eh.sendJob.code }}</p>
					<Button variant="outline" @click="signIn"
						>Open Microsoft sign-in</Button
					></template
				>
				<p v-if="eh.sendResult" role="status">{{ eh.sendResult.summary }}</p>
				<EventOperationStatistics
					:statistics="eh.sendResult?.statistics ?? progress?.statistics"
					:elapsed-ms="duration"
					label="Send statistics"
					sending
				/>
				<p v-if="eh.sendResult" class="explorer-note">
					{{ eh.sendResult.hubName }} · {{ eh.sendResult.routing.kind
					}}{{
						eh.sendResult.routing.kind !== 'automatic'
							? ': ' + eh.sendResult.routing.value
							: ''
					}}
					· {{ eh.sendResult.status }} · {{ (duration / 1000).toFixed(1) }}s
				</p>
				<p v-if="eh.sendResult?.lastBatchFirstIndex" class="mono">
					Last attempted batch: event indexes {{ eh.sendResult.lastBatchFirstIndex }}–{{
						eh.sendResult.lastBatchFirstIndex + eh.sendResult.lastBatchCount - 1
					}}. IDs: {{ eh.sendResult.operationId }}:&lt;index&gt;
				</p>
				<p v-if="eh.sendResult?.cleanupWarning" class="inspector-warning">
					{{ eh.sendResult.cleanupWarning }}
				</p>
				<p v-if="eh.sendInterrupted" class="inspector-warning">
					The final send outcome is unknown. Confirmed progress is only a lower bound.
					Check the retained result before sending again.
				</p>
				<Button v-if="eh.sending" variant="outline" @click="eh.cancel"
					>Cancel event send</Button
				>
				<Button
					v-else-if="eh.sendInterrupted"
					variant="outline"
					:disabled="!!eh.busy"
					@click="eh.recoverSend"
					>Check event send result</Button
				>
				<template v-else
					><label v-if="mustReview" class="check-row"
						><input v-model="reviewed" type="checkbox" />I have reviewed the uncertain
						batch and the risk of duplicate events.</label
					><Button
						variant="outline"
						:disabled="
							!!eh.busy ||
							!!eh.sendResult?.cleanupWarning ||
							(mustReview && !reviewed)
						"
						@click="prepare"
						>Prepare another event send</Button
					></template
				>
			</section>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.event-send-dialog {
	max-width: min(1100px, calc(100vw - 3rem));
}
.send-editor-layout {
	display: grid;
	grid-template-columns: 150px minmax(0, 1fr);
	gap: 1rem;
}
.draft-list {
	border-right: 1px solid var(--border);
	padding-right: 0.5rem;
	max-height: 360px;
	overflow: auto;
}
.draft-list > div {
	display: flex;
	align-items: center;
}
.draft-editor {
	display: grid;
	gap: 0.8rem;
	min-width: 0;
}
.send-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 0.75rem;
}
label {
	display: grid;
	gap: 0.25rem;
	font-size: 0.85rem;
}
select,
textarea {
	width: 100%;
	padding: 0.5rem;
	border: 1px solid var(--border);
	border-radius: 0.4rem;
	background: var(--background);
	color: var(--foreground);
}
.event-body-input {
	resize: vertical;
	max-height: 250px;
}
.check-row {
	display: flex;
	align-items: flex-start;
	gap: 0.5rem;
}
.property-editor {
	display: grid;
	grid-template-columns: 1fr 110px 1fr 35px;
	gap: 0.4rem;
	margin: 0.4rem 0;
}
summary {
	cursor: pointer;
	padding-bottom: 0.4rem;
}
.send-receipt {
	display: grid;
	gap: 1rem;
}
progress {
	width: 100%;
	accent-color: var(--primary);
}
.mono {
	overflow-wrap: anywhere;
}
</style>
