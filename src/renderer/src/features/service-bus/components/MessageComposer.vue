<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import MessageImport from './MessageImport.vue'
import { BodyCodecTools } from '@/features/body-tools'
import { composerBody } from '@/shared/lib/composer'
import {
	batchRequestSchema,
	draftSchema,
	draftPropertySchema,
	type MessageDraft,
	type SendTarget,
} from '@shared/message-operations'
const props = defineProps<{ target: SendTarget }>()
const emit = defineEmits<{ sent: [] }>()
const sb = useServiceBus()
const preferences = useWorkspace().preferences
const encoding = ref<'text' | 'json' | 'base64'>('json')
const body = ref('{\n  "message": "Hello"\n}')
const form = reactive<MessageDraft>({
	bodyBase64: '',
	messageId: crypto.randomUUID(),
	subject: preferences.messageSubject,
	contentType: preferences.messageContentType,
	correlationId: '',
	sessionId: '',
	replyTo: '',
	replyToSessionId: '',
	to: '',
	partitionKey: '',
	ttlSeconds: null,
	properties: [],
})
const batch = ref<MessageDraft[]>([])
const schedule = ref(false)
const enqueueTime = ref(new Date(Date.now() + 3600000).toISOString())
const blocked = computed(() => !!sb.busy || (submitted.value && sb.outcome?.status === 'unknown'))
function useCodecBody(value: string) {
	encoding.value = 'base64'
	body.value = value
}
const codecSource = computed(() => {
	try {
		return composerBody(body.value, encoding.value).base64
	} catch {
		return undefined
	}
})
const utcTime = computed(() =>
	Number.isFinite(Date.parse(enqueueTime.value))
		? new Date(enqueueTime.value).toISOString()
		: 'Invalid timestamp',
)
function acceptImport(drafts: MessageDraft[]) {
	const next = [...batch.value, ...drafts]
	const parsed = batchRequestSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: sb.connection?.connectionId,
		target: props.target,
		drafts: next,
		scheduledEnqueueTime: null,
	})
	if (!parsed.success) {
		validationError.value =
			'Imported drafts were not added. The combined batch must have at most 20 messages, distinct IDs and 512 KiB of serialized drafts.'
		return false
	}
	batch.value = next
	validationError.value = ''
	return true
}
async function saveDrafts() {
	if (!batch.value.length && !draft.value.value) {
		validationError.value = draft.value.error
		return
	}
	await sb.saveDrafts(batch.value.length ? batch.value : [draft.value.value!])
}
function useTtlSeconds() {
	delete form.ttlDuration
	form.ttlSeconds = null
}
function editDraft(index: number) {
	const value = batch.value[index]
	if (!value) return
	delete form.ttlDuration
	Object.assign(form, JSON.parse(JSON.stringify(value)))
	body.value = value.bodyBase64
	encoding.value = 'base64'
	batch.value.splice(index, 1)
	validationError.value =
		'Draft loaded as exact base64 bytes. Review and add it back to the batch.'
}
function addToBatch() {
	if (!draft.value.value) {
		validationError.value = draft.value.error
		return
	}
	const next = [...batch.value, draft.value.value]
	const parsed = batchRequestSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: sb.connection?.connectionId,
		target: props.target,
		drafts: next,
		scheduledEnqueueTime: null,
	})
	if (!parsed.success) {
		validationError.value = parsed.error.issues[0]?.message ?? 'Check batch limits.'
		return
	}
	batch.value = JSON.parse(JSON.stringify(next))
	form.messageId = crypto.randomUUID()
	validationError.value = ''
}
const validationError = ref(''),
	submitted = ref(false)
const draft = computed(() => {
	try {
		const result = composerBody(body.value, encoding.value)
		return {
			value: draftSchema.parse({ ...form, bodyBase64: result.base64 }),
			size: result.size,
			error: '',
		}
	} catch (cause) {
		return {
			value: undefined,
			size: 0,
			error: cause instanceof Error ? cause.message : 'Check the message fields.',
		}
	}
})
async function send() {
	validationError.value = ''
	if (!batch.value.length && !draft.value.value) {
		validationError.value = draft.value.error
		return
	}
	const drafts = batch.value.length ? batch.value : [draft.value.value!]
	if (schedule.value || batch.value.length) {
		const parsed = batchRequestSchema.safeParse({
			id: crypto.randomUUID(),
			connectionId: sb.connection?.connectionId,
			target: props.target,
			drafts,
			scheduledEnqueueTime: schedule.value ? enqueueTime.value : null,
		})
		if (!parsed.success) {
			validationError.value = parsed.error.issues[0]?.message ?? 'Check the batch.'
			return
		}
		if (schedule.value && Date.parse(enqueueTime.value) <= Date.now()) {
			validationError.value = 'Scheduled enqueue time must be in the future.'
			return
		}
	}
	submitted.value = true
	const result =
		schedule.value || batch.value.length
			? await sb.sendBatch(props.target, drafts, schedule.value ? enqueueTime.value : null)
			: await sb.send(props.target, draft.value.value!)
	if (result?.status === 'confirmed') emit('sent')
	if (!result) validationError.value = sb.error
}
async function checkOutcome() {
	await sb.checkOutcome()
	if (sb.outcome?.status === 'confirmed') emit('sent')
}
</script>
<template>
	<form class="composer-form" @submit.prevent="send">
		<div class="write-destination">
			<strong>{{ sb.connection?.namespace }}</strong
			><span>{{ target.kind }} / {{ target.name }}</span>
		</div>
		<MessageImport :disabled="blocked" :accept="acceptImport" />

		<BodyCodecTools
			:base64="codecSource"
			:disabled="blocked || codecSource === undefined"
			allow-apply
			@apply="useCodecBody"
		/>
		<p v-if="sb.fileNotice" class="explorer-note" role="status">{{ sb.fileNotice }}</p>
		<fieldset :disabled="blocked" class="composer-fields">
			<div class="composer-grid">
				<label
					>Message ID<Input
						v-model="form.messageId"
						aria-label="Message ID"
						:required="!batch.length"
						maxlength="128"
				/></label>
				<label
					>Subject<Input
						v-model="form.subject"
						aria-label="Message subject"
						maxlength="128"
				/></label>
				<label
					>Content type<Input
						v-model="form.contentType"
						aria-label="Content type"
						maxlength="128"
				/></label>
				<label
					>Session ID<Input
						v-model="form.sessionId"
						aria-label="Send session ID"
						placeholder="Required for session-enabled destinations"
						maxlength="128"
				/></label>
			</div>
			<label
				>Body encoding<select
					v-model="encoding"
					aria-label="Body encoding"
					class="commander-select"
				>
					<option value="json">JSON (UTF-8, original text)</option>
					<option value="text">Text (UTF-8)</option>
					<option value="base64">Binary (base64)</option>
				</select></label
			>
			<label
				>Message body<textarea
					v-model="body"
					aria-label="Message body"
					class="commander-textarea mono"
					rows="9"
					maxlength="349528"
					spellcheck="false"
				></textarea>
			</label>
			<p class="explorer-note">
				{{ draft.size }} body bytes · Maximum 256 KiB locally. Broker limits include
				headers. JSON numbers retain the text you entered.
			</p>
			<details>
				<summary>Additional headers</summary>
				<div class="composer-grid">
					<label
						>Correlation ID<Input
							v-model="form.correlationId"
							aria-label="Correlation ID"
							maxlength="128"
					/></label>
					<label v-if="!form.ttlDuration"
						>TTL (seconds)<Input
							:model-value="form.ttlSeconds ?? ''"
							type="number"
							min="1"
							max="31536000"
							aria-label="TTL seconds"
							placeholder="Blank uses entity default"
							@update:model-value="
								form.ttlSeconds = $event === '' ? null : Number($event)
							"
					/></label>
					<label v-if="form.ttlDuration"
						>Exact TTL duration (d.hh:mm:ss.fffffff)<Input
							v-model="form.ttlDuration"
							aria-label="Exact TTL duration"
							maxlength="64"
						/><Button type="button" variant="ghost" size="sm" @click="useTtlSeconds"
							>Use TTL seconds instead</Button
						></label
					>
					<label
						>Reply to<Input
							v-model="form.replyTo"
							aria-label="Reply to"
							maxlength="260"
					/></label>
					<label
						>Reply-to session ID<Input
							v-model="form.replyToSessionId"
							aria-label="Reply-to session ID"
							maxlength="128"
					/></label>
					<label
						>To<Input v-model="form.to" aria-label="To header" maxlength="260"
					/></label>
					<label
						>Partition key<Input
							v-model="form.partitionKey"
							aria-label="Partition key"
							maxlength="128"
					/></label>
				</div>
			</details>
			<div class="explorer-heading">
				<h3>Application properties</h3>
				<Button
					type="button"
					size="sm"
					variant="outline"
					:disabled="form.properties.length >= 32"
					@click="form.properties.push({ name: '', type: 'string', value: '' })"
					>Add property</Button
				>
			</div>
			<div v-for="(property, index) in form.properties" :key="index" class="property-editor">
				<Input
					v-model="property.name"
					:aria-label="'Property name ' + (index + 1)"
					placeholder="Name"
					maxlength="128"
				/>
				<select
					v-model="property.type"
					class="commander-select"
					:aria-label="'Property type ' + (index + 1)"
				>
					<option
						v-for="type in draftPropertySchema.shape.type.options"
						:key="type"
						:value="type"
					>
						{{ type }}
					</option>
				</select>
				<Input
					v-model="property.value"
					:aria-label="'Property value ' + (index + 1)"
					placeholder="Value"
					maxlength="4096"
				/>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					:aria-label="'Remove property ' + (index + 1)"
					@click="form.properties.splice(index, 1)"
					>Remove</Button
				>
			</div>
			<p class="explorer-note">
				Integers use decimal text; booleans true/false; dates use UTC timestamps such as
				2026-10-10T12:00:00Z; timespans use d.hh:mm:ss. Binary property values need explicit
				base64 strings because of a broker limitation.
			</p>
			<div class="batch-composer">
				<div class="explorer-heading">
					<h3>Batch ({{ batch.length }} / 20)</h3>
					<Button
						type="button"
						variant="outline"
						:disabled="batch.length >= 20"
						@click="addToBatch"
						>Add draft to batch</Button
					>
				</div>
				<p class="explorer-note">
					Add different drafts or repeat this body with generated message IDs. When the
					list is populated, only listed drafts will be sent. Maximum 512 KiB of
					serialized drafts; the complete batch must also fit the broker limit. All
					messages must share their session ID and partition key.
				</p>
				<div v-for="(item, index) in batch" :key="item.messageId" class="explorer-heading">
					<span class="mono"
						>{{ index + 1 }}. {{ item.messageId }} ·
						{{ item.subject || '(no subject)' }}</span
					>
					<Button
						type="button"
						variant="outline"
						size="sm"
						:aria-label="'Edit batch message ' + (index + 1)"
						@click="editDraft(index)"
						>Edit draft</Button
					>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						:aria-label="'Remove batch message ' + (index + 1)"
						@click="batch.splice(index, 1)"
						>Remove</Button
					>
				</div>
			</div>
			<label class="schedule-toggle"
				><input
					v-model="schedule"
					type="checkbox"
					aria-label="Schedule for later"
				/>Schedule for later</label
			>
			<label v-if="schedule"
				>Scheduled enqueue time (ISO 8601, explicit timezone)
				<Input
					v-model="enqueueTime"
					aria-label="Scheduled enqueue time"
					@update:model-value="validationError = ''"
					placeholder="2026-10-11T12:00:00Z"
					maxlength="64"
				/>
				<small
					>UTC: {{ utcTime }}. Azure retains scheduled messages while the app is
					closed.</small
				>
			</label>
		</fieldset>
		<p v-if="validationError" class="error-banner" role="alert">{{ validationError }}</p>
		<p v-if="submitted && sb.outcome" class="inspector-warning" role="status">
			{{ sb.outcome.status }}: {{ sb.outcome.summary }}
			<Button
				v-if="sb.outcome.status === 'unknown'"
				type="button"
				variant="outline"
				size="sm"
				:disabled="!!sb.busy"
				@click="checkOutcome"
				>Check outcome</Button
			>
		</p>
		<p class="explorer-note">
			The broker accepts the complete batch or rejects it; interrupted requests can have
			unknown outcomes. Topic subscriptions receive copies according to their filters. Reusing
			a message ID can trigger duplicate detection.
		</p>
		<Button type="button" variant="outline" :disabled="blocked" @click="saveDrafts"
			>Save drafts to file</Button
		>
		<Button type="submit" :disabled="blocked">{{
			schedule
				? batch.length
					? 'Schedule batch'
					: 'Schedule message'
				: batch.length
					? 'Send batch'
					: 'Send message'
		}}</Button>
	</form>
</template>
