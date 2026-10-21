<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { inspectedDelivery } from '../lib/inspected-message'
import { entityPath } from '@shared/entity-management'
import {
	subQueueLabel,
	type EntityTarget,
	type MessageSubQueue,
	type MessageSummary,
} from '@shared/service-bus'
import type { OperationOutcome } from '@shared/message-operations'
const props = defineProps<{
	source: EntityTarget
	subQueue: MessageSubQueue
	summary: MessageSummary
	canReceive?: boolean
	requiresSession?: boolean
}>()
const sb = useServiceBus()
const action = ref<'delete' | 'resend'>()
const acknowledged = ref(false),
	received = ref(false),
	removeOriginal = ref(false)
const destinationKind = ref<'queue' | 'topic'>(
	props.source.kind === 'subscription' ? 'topic' : props.source.kind,
)
const destinationName = ref(
	props.source.kind === 'subscription' ? props.source.topicName : props.source.name,
)
const idPolicy = ref<'new' | 'preserve'>('new'),
	messageId = ref(crypto.randomUUID() as string)
const receipt = ref<OperationOutcome>()
const now = ref(Date.now())
const timer = setInterval(() => {
	now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))
const delivery = computed(() =>
	inspectedDelivery(sb.held, props.source, props.subQueue, props.summary),
)
const locked = computed(
	() => delivery.value?.state === 'active' && Date.parse(delivery.value.lockedUntil) > now.value,
)
const scheduled = computed(
	() =>
		props.summary.state === 'Scheduled' &&
		props.subQueue === 'active' &&
		props.source.kind !== 'subscription',
)
const needsLock = computed(
	() => (action.value === 'delete' && !scheduled.value) || removeOriginal.value,
)
const unavailable = computed(
	() => !!delivery.value && ['completed', 'replayed', 'unknown'].includes(delivery.value.state),
)
const canReceive = computed(
	() =>
		props.canReceive &&
		props.source.kind !== 'topic' &&
		props.summary.state !== 'Scheduled' &&
		!unavailable.value,
)
const pending = computed(() =>
	sb.held.items.some(
		(item) =>
			item.state === 'unknown' ||
			(item.state === 'active' && Date.parse(item.lockedUntil) > now.value),
	),
)
const valid = computed(
	() =>
		acknowledged.value &&
		!sb.busy &&
		!receipt.value &&
		(!needsLock.value || locked.value) &&
		(action.value !== 'resend' ||
			(destinationName.value.trim().length > 0 &&
				destinationName.value.length <= 260 &&
				messageId.value.trim().length > 0 &&
				messageId.value.length <= 128 &&
				(idPolicy.value === 'preserve' || messageId.value !== props.summary.messageId))),
)
function open(kind: 'delete' | 'resend') {
	action.value = kind
	acknowledged.value = false
	removeOriginal.value = false
}
watch([destinationKind, destinationName, messageId, removeOriginal, action], () => {
	acknowledged.value = false
})
watch(idPolicy, (policy) => {
	messageId.value = policy === 'new' ? crypto.randomUUID() : (props.summary.messageId ?? '')
})
async function receive() {
	if (!canReceive.value || pending.value || sb.busy || props.source.kind === 'topic') return
	received.value = false
	await sb.receive(
		10,
		2,
		props.requiresSession ? (props.summary.sessionId ?? '') : '',
		props.summary.state === 'Deferred' ? props.summary.sequenceNumber : undefined,
		undefined,
		{ target: { ...props.source }, subQueue: props.subQueue },
	)
	received.value = true
	acknowledged.value = false
}
async function checkOutcome() {
	if (!receipt.value || sb.outcome?.operationId !== receipt.value.operationId) return
	await sb.checkOutcome()
	if (sb.outcome?.operationId === receipt.value.operationId) receipt.value = sb.outcome
}
async function confirm() {
	if (!valid.value) return
	const source = { ...props.source }
	// Capture the exact owned handle before awaiting anything; never settle the next available message.
	if (action.value === 'delete') {
		receipt.value =
			scheduled.value && source.kind !== 'subscription'
				? await sb.cancelScheduled(
						source,
						[props.summary.sequenceNumber],
						`${source.kind}/${source.name}`,
						true,
					)
				: await sb.settle(delivery.value!.deliveryId, 'complete')
	} else if (action.value === 'resend') {
		const destination = { kind: destinationKind.value, name: destinationName.value }
		receipt.value = removeOriginal.value
			? await sb.replay(
					delivery.value!.deliveryId,
					destination,
					idPolicy.value,
					messageId.value,
				)
			: await sb.resendSnapshot(
					props.summary.snapshotId!,
					destination,
					idPolicy.value,
					messageId.value,
				)
	}
	acknowledged.value = false
}
</script>
<template>
	<section class="inspector-message-actions" aria-label="Inspected message actions">
		<div class="explorer-actions">
			<Button
				size="sm"
				variant="outline"
				:disabled="!!sb.busy || !!receipt"
				@click="open('resend')"
				>Resend message</Button
			>
			<Button
				size="sm"
				variant="destructive"
				:disabled="!!sb.busy || !!receipt || unavailable"
				@click="open('delete')"
				>Delete message</Button
			>
		</div>
		<div v-if="action && !receipt" class="inspector-action-form">
			<p class="write-destination">
				{{ sb.connection?.namespace }} / {{ entityPath(source) }} ·
				{{ subQueueLabel(subQueue) }} · #{{ summary.sequenceNumber }}
			</p>
			<template v-if="action === 'resend'">
				<div class="explorer-actions">
					<label
						>Destination type<select
							v-model="destinationKind"
							aria-label="Inspected message destination type"
							:disabled="!!sb.busy"
						>
							<option value="queue">Queue</option>
							<option value="topic">Topic</option>
						</select></label
					>
					<label
						>Destination name<Input
							v-model="destinationName"
							aria-label="Inspected message destination"
							maxlength="260"
							:disabled="!!sb.busy"
					/></label>
				</div>
				<div class="explorer-actions">
					<label
						>Message ID policy<select
							v-model="idPolicy"
							aria-label="Inspected message ID policy"
							:disabled="!!sb.busy"
						>
							<option value="new">New message ID</option>
							<option value="preserve">Preserve original message ID</option>
						</select></label
					>
					<label
						>Message ID<Input
							v-model="messageId"
							aria-label="Resent message ID"
							maxlength="128"
							:disabled="!!sb.busy || idPolicy === 'preserve'"
					/></label>
				</div>
				<p class="explorer-note">
					Send the complete original body and application properties. The TTL starts
					again; old scheduling and dead-letter diagnostics are removed. Duplicate
					detection may discard a preserved ID. A topic delivers to every matching
					subscription.
				</p>
				<label v-if="subQueue !== 'active'" class="purge-ack"
					><input v-model="removeOriginal" type="checkbox" :disabled="!!sb.busy" />Remove
					the original after resending (requires a lock; send and removal use one
					transaction).</label
				>
				<p v-else class="explorer-note">The original message is kept.</p>
			</template>
			<p v-if="action === 'delete'" class="inspector-warning">
				{{
					scheduled
						? 'Cancel this scheduled message. Activation can race cancellation.'
						: 'Permanently delete only this message by completing its owned lock.'
				}}
			</p>
			<template v-if="needsLock && !locked">
				<p class="explorer-note">
					A peeked snapshot has no lock. Receive up to 10 available messages with a
					2-second wait budget, then confirm deletion only if this exact message is
					returned. Other messages stay held for your review in Message operations.
					Receiving may increase delivery counts; unhandled locks eventually expire.
				</p>
				<p v-if="summary.state === 'Deferred'" class="explorer-note">
					This deferred message will be received by its exact sequence number.
				</p>
				<p v-if="!canReceive" class="inspector-warning">
					Receive and inspect this message from Message operations to obtain a current
					lock.
				</p>
				<p v-else-if="pending" class="inspector-warning">
					Settle the current held batch or close its receiver in Message operations before
					receiving again.
				</p>
				<Button
					v-if="canReceive"
					variant="outline"
					:disabled="!!sb.busy || pending"
					@click="receive"
					>Receive and lock for this message</Button
				>
				<p v-if="received && !locked" role="status">
					This message was not available in the received batch. Nothing was deleted or
					resent. Review the held messages in Message operations.
				</p>
			</template>
			<label class="purge-ack"
				><input
					v-model="acknowledged"
					type="checkbox"
					:disabled="!!sb.busy || (needsLock && !locked)"
				/>{{
					action === 'delete'
						? 'I understand this message will be permanently deleted.'
						: 'I reviewed the destination and message ID policy.'
				}}</label
			>
			<div class="explorer-actions">
				<Button
					:variant="action === 'delete' ? 'destructive' : 'default'"
					:disabled="!valid"
					@click="confirm"
					>{{
						action === 'delete' ? 'Confirm delete message' : 'Confirm resend message'
					}}</Button
				><Button variant="outline" :disabled="!!sb.busy" @click="action = undefined"
					>Cancel message action</Button
				>
			</div>
		</div>
		<div v-if="receipt" class="operation-outcome" :class="receipt.status" role="status">
			<strong>{{ receipt.status }}</strong>
			<p>{{ receipt.summary }}</p>
			<small>Receipt {{ receipt.operationId }}</small
			><Button
				v-if="receipt.status === 'unknown'"
				size="sm"
				variant="outline"
				:disabled="!!sb.busy"
				@click="checkOutcome"
				>Check outcome</Button
			>
		</div>
	</section>
</template>

<style scoped>
.inspector-message-actions {
	display: grid;
	gap: 10px;
}
.inspector-action-form {
	display: grid;
	gap: 10px;
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 8px;
}
.inspector-action-form p {
	margin: 0;
}
.inspector-action-form .explorer-actions {
	align-items: end;
}
.inspector-action-form label:not(.purge-ack) {
	display: grid;
	gap: 4px;
	flex: 1;
	min-width: 140px;
	font-size: 12px;
}
.inspector-action-form select {
	padding: 7px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	color: var(--foreground);
}
.inspector-action-form .purge-ack {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
}
.inspector-action-form .purge-ack input {
	width: auto;
	flex-shrink: 0;
}
</style>
