<script setup lang="ts">
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import ActionConfirmation from '../../../shared/components/ActionConfirmation.vue'
import { computed, ref } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import {
	cancelScheduledRequestSchema,
	type OperationOutcome,
	type SendTarget,
} from '@shared/message-operations'
import { sequenceSchema, type MessageSummary, type PeekPage } from '@shared/service-bus'
import MessageInspector from './MessageInspector.vue'
const props = defineProps<{ target: SendTarget }>()
const sb = useServiceBus()
const page = ref<PeekPage>()
const from = ref('0'),
	pageStart = ref('0'),
	sequences = ref(''),
	confirmation = ref(''),
	error = ref('')
const receipt = ref<OperationOutcome>()
const inspecting = ref(false)
const path = computed(() => `${props.target.kind}/${props.target.name}`)
const blocked = computed(() => !!sb.busy || receipt.value?.status === 'unknown')
async function load(next = false) {
	const start = next ? page.value?.nextSequenceNumber : from.value
	if (!start || !sequenceSchema.safeParse(start).success) {
		error.value = 'Enter a valid Int64 sequence number.'
		return
	}
	error.value = ''
	const result = await sb.listScheduled(props.target, start)
	if (result) {
		page.value = result
		pageStart.value = start
		from.value = start
		inspecting.value = false
	}
}
async function inspect(item: MessageSummary) {
	await sb.inspect(item)
	inspecting.value = !!sb.message
}
function select(item: MessageSummary) {
	sequences.value = item.sequenceNumber
	confirmation.value = ''
}
async function cancel() {
	error.value = ''
	const sequenceNumbers = sequences.value.trim().split(/[\s,]+/)
	const parsed = cancelScheduledRequestSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: sb.connection?.connectionId,
		target: props.target,
		sequenceNumbers,
		confirmation: confirmation.value,
	})
	if (!parsed.success || confirmation.value !== path.value) {
		error.value = `Enter 1–20 distinct sequence numbers and confirm cancellation using the checkbox.`
		return
	}
	receipt.value = await sb.cancelScheduled(props.target, sequenceNumbers, confirmation.value)
	inspecting.value = false
	if (receipt.value?.status === 'confirmed') {
		confirmation.value = ''
		sequences.value = ''
		from.value = pageStart.value
		await load()
	}
}
async function checkOutcome() {
	if (sb.outcome?.operationId !== receipt.value?.operationId) return
	await sb.checkOutcome()
	receipt.value = sb.outcome
}
</script>
<template>
	<section class="scheduled-manager" aria-label="Scheduled message browser">
		<LoadingIndicator v-if="sb.busy" :label="`${sb.busy}…`" />
		<p class="write-destination">
			<strong>{{ sb.connection?.namespace }}</strong
			><span>{{ path }}</span>
		</p>
		<div class="explorer-actions">
			<label
				>From sequence<Input
					v-model="from"
					aria-label="Scheduled from sequence"
					maxlength="19"
					:disabled="!!sb.busy"
			/></label>
			<Button variant="outline" :disabled="!!sb.busy" @click="load()"
				>Refresh scheduled messages</Button
			>
			<Button
				variant="outline"
				:disabled="!!sb.busy || !page?.nextSequenceNumber"
				@click="load(true)"
				>Scan next page</Button
			>
		</div>
		<p class="explorer-note">
			Each page scans up to 25 broker messages and shows only those still scheduled. An empty
			page can contain active or deferred messages; scan next to continue. This is a changing
			snapshot, not a complete inventory. Topic schedules live on the topic until activation.
		</p>
		<p v-if="page" class="explorer-note">
			Fetched {{ page.fetchedAt }} · {{ page.items.length }} scheduled on this page · Next
			sequence
			{{ page.nextSequenceNumber ?? 'end of sequence range' }}
		</p>
		<Button
			v-if="page?.items.length"
			variant="outline"
			:disabled="!!sb.busy || page.items.some((item) => !item.snapshotId)"
			@click="sb.exportMessages(page.items)"
			>Export scheduled page</Button
		>
		<p v-if="sb.fileNotice" role="status" class="explorer-note">{{ sb.fileNotice }}</p>
		<p v-if="page?.warning" class="inspector-warning">{{ page.warning }}</p>
		<p v-if="page && !page.items.length" class="explorer-note">
			No scheduled messages found in this scan.
		</p>
		<article
			v-for="item in page?.items"
			:key="item.sequenceNumber"
			class="held-message"
			:aria-label="'Scheduled ' + item.messageId"
		>
			<strong>{{ item.messageId ?? '(No message ID)' }}</strong>
			<p class="mono">#{{ item.sequenceNumber }} · {{ item.scheduledEnqueueTime }}</p>
			<div class="explorer-actions">
				<Button
					size="sm"
					variant="outline"
					:disabled="!!sb.busy || !item.snapshotId"
					@click="inspect(item)"
					>Inspect scheduled</Button
				><Button size="sm" variant="outline" :disabled="blocked" @click="select(item)"
					>Choose for cancellation</Button
				>
			</div>
		</article>
		<MessageInspector v-if="inspecting" :source="target" />
		<form class="composer-form" @submit.prevent="cancel">
			<h3>Cancel scheduled messages</h3>
			<p class="explorer-note">
				Select a message above or paste up to 20 scheduled sequence numbers from a receipt
				for this destination. Cancellation permanently removes pending schedules. It cannot
				recall activated messages, and activation can race cancellation.
			</p>
			<fieldset :disabled="blocked" class="composer-fields">
				<label
					>Scheduled sequence numbers<Input
						v-model="sequences"
						aria-label="Scheduled sequence numbers"
						placeholder="Comma or whitespace separated"
						maxlength="419"
				/></label>
				<ActionConfirmation
					v-model="confirmation"
					:expected="path"
					label="I understand these scheduled messages will be permanently cancelled."
					:context="sequences"
				/>
				<Button
					type="submit"
					variant="destructive"
					:disabled="confirmation !== path || !sequences.trim()"
					>Cancel scheduled messages</Button
				>
			</fieldset>
		</form>
		<p v-if="error || sb.error" class="error-banner" role="alert">{{ error || sb.error }}</p>
		<div v-if="receipt" role="status" class="operation-outcome" :class="receipt.status">
			<strong>{{ receipt.status }}</strong>
			<p>{{ receipt.summary }}</p>
			<small class="mono">Receipt {{ receipt.operationId }}</small
			><Button
				v-if="receipt.status === 'unknown'"
				variant="outline"
				:disabled="!!sb.busy"
				@click="checkOutcome"
				>Check cancellation outcome</Button
			>
		</div>
	</section>
</template>
