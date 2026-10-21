<script setup lang="ts">
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import { subQueueLabel, type MessageSubQueue, type DeadLetterSubQueue } from '@shared/service-bus'

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import type { Delivery, SendTarget, SettleRequest } from '@shared/message-operations'
import ScheduledMessages from './ScheduledMessages.vue'
import MessageComposer from './MessageComposer.vue'
import SessionManager from './SessionManager.vue'
import MessagePurge from './MessagePurge.vue'
import DeferredMessages from './DeferredMessages.vue'
import DeadLetterResend from './DeadLetterResend.vue'
import type { PeekTarget } from '@shared/service-bus'
import MessageInspector from './MessageInspector.vue'
const emit = defineEmits<{
	'receive-delete': [target: PeekTarget, subQueue: MessageSubQueue, sessionId: string]
}>()
const sb = useServiceBus()
const workspace = useWorkspace()
const composer = ref<SendTarget>()
const resendTarget = ref<{ target: PeekTarget; subQueue: DeadLetterSubQueue }>()
function openResend(
	target = sb.selected?.target,
	subQueue: DeadLetterSubQueue = sb.subQueue === 'transfer-dead-letter'
		? sb.subQueue
		: 'dead-letter',
) {
	if (!sb.busy && sb.connection && target && target.kind !== 'topic')
		resendTarget.value = { target: { ...target }, subQueue }
}
function closeResend() {
	if (sb.busy !== 'Resend dead-letter messages') resendTarget.value = undefined
}
const purgeTarget = ref<{ target: PeekTarget; subQueue: MessageSubQueue }>()
function openPurge(target = sb.selected?.target, subQueue = sb.subQueue) {
	if (!sb.busy && sb.connection && target && target.kind !== 'topic')
		purgeTarget.value = { target: { ...target }, subQueue }
}
function closePurge() {
	if (sb.busy !== 'Purge messages') purgeTarget.value = undefined
}
const sessionsTarget = ref<PeekTarget>()
function openSessions() {
	if (sb.selected?.target.kind !== 'topic' && sb.selected)
		sessionsTarget.value = { ...sb.selected.target }
}
function closeSessions() {
	sessionsTarget.value = undefined
}
const scheduledTarget = ref<SendTarget>()
function openScheduled() {
	if (sb.selected && sb.selected.target.kind !== 'subscription')
		scheduledTarget.value = { ...sb.selected.target }
}
function closeScheduled() {
	scheduledTarget.value = undefined
}
const maxMessages = ref(1),
	waitSeconds = ref(workspace.preferences.receiveWaitSeconds),
	sessionId = ref('')
watch(
	() => workspace.preferences.receiveWaitSeconds,
	(value) => {
		waitSeconds.value = value
	},
)
const deferredSequence = ref('')
const inspectOpen = ref(false)
const action = ref<{ delivery?: Delivery; kind: SettleRequest['action'] | 'replay' | 'close' }>()
const reason = ref('ManualReview'),
	description = ref('')
const destinationKind = ref<'queue' | 'topic'>('queue'),
	destinationName = ref('')
const idPolicy = ref<'new' | 'preserve'>('new'),
	replayId = ref('')
const now = ref(Date.now())
const timer = setInterval(() => {
	now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))
const needsSession = computed(() => !!sb.selected?.requiresSession && sb.subQueue === 'active')
const hasPending = computed(() =>
	sb.held.items.some(
		(item) =>
			item.state === 'unknown' ||
			(item.state === 'active' && Date.parse(item.lockedUntil) > now.value),
	),
)
const source = computed(() =>
	sb.held.target
		? sb.held.target.kind === 'subscription'
			? `${sb.held.target.topicName} / ${sb.held.target.name}`
			: sb.held.target.name
		: '',
)
const actionText = computed(
	() =>
		({
			complete: 'Permanently remove this received message.',
			abandon: 'Release this message for another delivery. Delivery count may increase.',
			'dead-letter': 'Move this message into its dead-letter queue with the reason below.',
			defer: 'Defer this message. Its sequence is recorded for this app session; normal receives will no longer return it.',
			renew: 'Renew the owned message lock, or the whole session lock for a session receiver.',
			replay: 'Publish the original body and application properties and complete the source in one transaction. The original TTL starts again; old scheduling and dead-letter diagnostics are removed.',
			close: 'Close the receiver without settling outstanding messages. Locks expire at the broker; repeated expiry can cause dead-lettering.',
		})[action.value?.kind ?? 'close'],
)
function openComposer(target = sb.selected?.target) {
	if (!sb.busy && sb.connection && target && target.kind !== 'subscription')
		composer.value = { ...target }
}
defineExpose({ openPurge, openComposer, openResend })
function openAction(delivery: Delivery, kind: SettleRequest['action'] | 'replay') {
	action.value = { delivery, kind }
	reason.value = 'ManualReview'
	description.value = ''
	destinationKind.value = sb.held.target?.kind === 'subscription' ? 'topic' : 'queue'
	destinationName.value =
		sb.held.target?.kind === 'subscription'
			? sb.held.target.topicName
			: (sb.held.target?.name ?? '')
	idPolicy.value = 'new'
	replayId.value = crypto.randomUUID()
}
function changePolicy() {
	replayId.value =
		idPolicy.value === 'preserve'
			? (action.value?.delivery?.summary.messageId ?? '')
			: crypto.randomUUID()
}
function closeAction() {
	action.value = undefined
}
function closeComposer() {
	composer.value = undefined
}
async function inspect(delivery: Delivery) {
	await sb.inspect(delivery.summary)
	if (sb.message) inspectOpen.value = true
}
async function confirm() {
	const current = action.value
	if (!current) return
	if (current.kind === 'close') await sb.closeReceiver()
	else if (current.delivery && current.kind === 'replay')
		await sb.replay(
			current.delivery.deliveryId,
			{ kind: destinationKind.value, name: destinationName.value },
			idPolicy.value,
			replayId.value,
		)
	else if (current.delivery && current.kind !== 'replay')
		await sb.settle(current.delivery.deliveryId, current.kind, reason.value, description.value)
	closeAction()
}
function closeReceiver() {
	action.value = { kind: 'close' }
}
watch(
	() => sb.connection?.connectionId,
	() => {
		closeAction()
		closeComposer()
		closeScheduled()
		closeSessions()
		purgeTarget.value = undefined
		resendTarget.value = undefined
		inspectOpen.value = false
	},
)
watch(
	() => sb.selected?.target,
	() => {
		sessionId.value = ''
		deferredSequence.value = ''
	},
)
watch(
	() => sb.held.session,
	(session) => {
		if (
			session &&
			sb.selected?.target.kind === session.target.kind &&
			sb.selected.target.name === session.target.name &&
			(session.target.kind === 'queue' ||
				(sb.selected.target.kind === 'subscription' &&
					sb.selected.target.topicName === session.target.topicName))
		)
			sessionId.value = session.sessionId
	},
)
</script>
<template>
	<section class="message-workbench" aria-label="Message operations">
		<div class="explorer-heading">
			<h3>Message operations</h3>
			<Button
				v-if="
					sb.selected && sb.selected.target.kind !== 'topic' && sb.subQueue !== 'active'
				"
				variant="outline"
				:disabled="!!sb.busy"
				@click="openResend()"
				>Resend {{ subQueueLabel(sb.subQueue).toLowerCase() }} messages</Button
			>
			<Button
				v-if="sb.selected && sb.selected.target.kind !== 'topic'"
				variant="outline"
				:disabled="!!sb.busy"
				@click="openPurge()"
				>Purge messages</Button
			>
			<Button
				v-if="
					sb.selected?.requiresSession &&
					sb.selected.target.kind !== 'topic' &&
					sb.subQueue === 'active'
				"
				variant="outline"
				:disabled="!!sb.busy"
				@click="openSessions"
				>Sessions</Button
			>
			<Button
				v-if="sb.selected && sb.selected.target.kind !== 'subscription'"
				variant="outline"
				:disabled="!!sb.busy"
				@click="openScheduled"
				>Scheduled messages</Button
			>
			<Button
				v-if="sb.selected && sb.selected.target.kind !== 'subscription'"
				:disabled="!!sb.busy"
				@click="openComposer()"
				>Compose message</Button
			>
		</div>
		<Button
			v-if="sb.selected && sb.selected.target.kind !== 'topic'"
			variant="outline"
			:disabled="!!sb.busy"
			@click="emit('receive-delete', sb.selected.target, sb.subQueue, sessionId)"
			>Receive &amp; delete…</Button
		>
		<div v-if="sb.selected && sb.selected.target.kind !== 'topic'" class="receive-controls">
			<strong
				>Receive from {{ sb.selected.target.name }} /
				{{
					sb.subQueue === 'active'
						? 'main queue'
						: subQueueLabel(sb.subQueue).toLowerCase()
				}}</strong
			>
			<div class="explorer-actions">
				<label
					>Maximum messages<Input
						v-model.number="maxMessages"
						type="number"
						min="1"
						max="10"
						aria-label="Receive count"
						class="page-size-input"
				/></label>
				<label
					>Wait budget (seconds)<Input
						v-model.number="waitSeconds"
						type="number"
						min="1"
						max="20"
						aria-label="Receive wait seconds"
						class="page-size-input"
				/></label>
				<label v-if="sb.subQueue === 'active'"
					>Session ID{{ needsSession ? ' (required)' : ' (optional)'
					}}<Input v-model="sessionId" aria-label="Receive session ID" maxlength="128"
				/></label>
				<label
					>Deferred sequence (optional)<Input
						v-model="deferredSequence"
						aria-label="Deferred sequence"
						placeholder="Blank for normal receive"
						maxlength="19"
				/></label>
				<Button
					:disabled="!!sb.busy || hasPending || (needsSession && !sessionId.trim())"
					@click="sb.receive(maxMessages, waitSeconds, sessionId, deferredSequence)"
					>Receive and lock</Button
				>
			</div>
			<p class="explorer-note">
				Receive and lock uses PeekLock. Receiving temporarily hides these messages from
				other consumers. Choose a settlement before the lock expires. A deferred sequence
				retrieves one specific message; the wait budget applies to normal receive.
				Dead-letter receives are not session filtered.
			</p>
			<DeferredMessages :session-id="sessionId" @select="deferredSequence = $event" />
		</div>
		<LoadingIndicator
			v-if="sb.busy === 'Receive and lock messages' || sb.busy === 'Refresh held messages'"
			label="Retrieving received messages…"
		/>
		<div class="explorer-actions">
			<Button variant="outline" size="sm" :disabled="!!sb.busy" @click="sb.refreshHeld()"
				>Refresh held messages</Button
			><Button
				v-if="sb.held.target"
				variant="outline"
				size="sm"
				:disabled="!!sb.busy"
				@click="closeReceiver"
				>Close receiver</Button
			>
		</div>
		<Button
			v-if="sb.held.items.length"
			variant="outline"
			:disabled="!!sb.busy || sb.held.items.some((item) => !item.summary.snapshotId)"
			@click="sb.exportMessages(sb.held.items.map((item) => item.summary))"
			>Export received batch</Button
		>
		<p v-if="sb.fileNotice" role="status" class="explorer-note">{{ sb.fileNotice }}</p>
		<template v-if="sb.held.target">
			<h4>
				Received batch: {{ source }} / {{ sb.held.subQueue
				}}{{ sb.held.sessionId ? ' · Session ' + sb.held.sessionId : '' }}
			</h4>
			<p v-if="sb.held.warning" class="inspector-warning">{{ sb.held.warning }}</p>
			<p v-if="!sb.held.items.length" class="explorer-note">
				No messages returned within the wait budget.
			</p>
			<article
				v-for="delivery in sb.held.items"
				:key="delivery.deliveryId"
				class="held-message"
				:aria-label="'Received ' + delivery.summary.messageId"
			>
				<div class="explorer-heading">
					<div class="message-identity">
						<strong class="message-label-text">{{
							delivery.summary.subject?.trim() ? delivery.summary.subject : 'No label'
						}}</strong>
						<p class="message-identity-meta">
							<span>{{ delivery.summary.messageId ?? '(No message ID)' }}</span>
							<span>#{{ delivery.summary.sequenceNumber }}</span>
						</p>
					</div>
					<span
						>{{ delivery.state
						}}<template v-if="delivery.state === 'active'">
							·
							{{
								Math.max(
									0,
									Math.ceil((Date.parse(delivery.lockedUntil) - now) / 1000),
								)
							}}s remaining</template
						></span
					>
				</div>
				<p v-if="delivery.state === 'active'" class="explorer-note">
					Lock expires {{ delivery.lockedUntil }}. The countdown is an estimate; the
					broker decides whether the lock is still valid.
				</p>
				<div class="explorer-actions">
					<Button
						variant="outline"
						size="sm"
						:disabled="!!sb.busy || !delivery.summary.snapshotId"
						@click="inspect(delivery)"
						>Inspect received</Button
					>
					<template
						v-if="delivery.state === 'active' && Date.parse(delivery.lockedUntil) > now"
					>
						<Button
							v-for="kind in [
								'complete',
								'abandon',
								'dead-letter',
								'defer',
								'renew',
							] as const"
							v-show="kind !== 'dead-letter' || sb.held.subQueue === 'active'"
							:key="kind"
							variant="outline"
							size="sm"
							:disabled="!!sb.busy"
							@click="openAction(delivery, kind)"
							>{{
								{
									complete: 'Complete',
									abandon: 'Abandon',
									'dead-letter': 'Dead-letter received',
									defer: 'Defer',
									renew: 'Renew lock',
								}[kind]
							}}</Button
						>
						<Button
							v-if="sb.held.subQueue !== 'active'"
							size="sm"
							:disabled="!!sb.busy"
							@click="openAction(delivery, 'replay')"
							>Replay dead-letter</Button
						>
					</template>
				</div>
				<p v-if="delivery.state === 'unknown'" class="inspector-warning">
					This handle is blocked because its last outcome is unknown. Check the receipt
					and broker state before closing the receiver or receiving again.
				</p>
			</article>
			<p class="explorer-note">
				Disconnecting, changing profiles or reloading closes this receiver. Unsettled locks
				then expire; the app never completes them automatically.
			</p>
		</template>
		<div v-if="sb.outcome" class="operation-outcome" :class="sb.outcome.status" role="status">
			<strong>{{ sb.outcome.status.toUpperCase() }}</strong>
			<p>{{ sb.outcome.summary }}</p>
			<p v-if="sb.outcome.sequenceNumbers?.length" class="mono">
				Sequence numbers: {{ sb.outcome.sequenceNumbers.join(', ') }}
			</p>
			<small class="mono"
				>Receipt {{ sb.outcome.operationId
				}}{{ sb.outcome.messageId ? ' · Message ID ' + sb.outcome.messageId : '' }}</small
			><Button variant="outline" size="sm" :disabled="!!sb.busy" @click="sb.checkOutcome()"
				>Check outcome</Button
			>
		</div>
		<p v-if="sb.held.session" class="inspector-warning">
			Owned session {{ sb.held.session.sessionId }} · {{ sb.held.session.status }} · expires
			{{ sb.held.session.lockedUntil }}. Manage state and renew/release its lock in Sessions.
		</p>
		<Dialog :open="!!resendTarget" @update:open="closeResend">
			<DialogContent
				class="message-dialog resend-dialog"
				:show-close-button="sb.busy !== 'Resend dead-letter messages'"
				@escape-key-down="
					sb.busy === 'Resend dead-letter messages' && $event.preventDefault()
				"
				@interact-outside="
					sb.busy === 'Resend dead-letter messages' && $event.preventDefault()
				"
			>
				<DialogHeader
					><DialogTitle
						>Resend
						{{ subQueueLabel(resendTarget?.subQueue ?? 'dead-letter').toLowerCase() }}
						messages</DialogTitle
					><DialogDescription
						>Choose the destination and whether to keep or remove the
						originals.</DialogDescription
					></DialogHeader
				>
				<DeadLetterResend
					v-if="resendTarget"
					:source="resendTarget.target"
					:sub-queue="resendTarget.subQueue"
				/>
			</DialogContent>
		</Dialog>
		<Dialog :open="!!purgeTarget" @update:open="closePurge"
			><DialogContent class="message-dialog" :show-close-button="sb.busy !== 'Purge messages'"
				><DialogHeader
					><DialogTitle>Purge messages</DialogTitle
					><DialogDescription
						>Confirm the destination, set limits and review permanent
						deletions.</DialogDescription
					></DialogHeader
				><MessagePurge
					v-if="purgeTarget"
					:target="purgeTarget.target"
					:sub-queue="purgeTarget.subQueue" /></DialogContent
		></Dialog>
		<Dialog :open="!!sessionsTarget" @update:open="closeSessions"
			><DialogContent class="message-dialog"
				><DialogHeader
					><DialogTitle>Session management</DialogTitle
					><DialogDescription
						>List sessions, own a session lock and manage its state or
						messages.</DialogDescription
					></DialogHeader
				><SessionManager
					v-if="sessionsTarget"
					:target="sessionsTarget"
					@received="closeSessions" /></DialogContent
		></Dialog>
		<Dialog :open="!!scheduledTarget" @update:open="closeScheduled"
			><DialogContent class="message-inspection-dialog" movable resizable
				><DialogHeader
					><DialogTitle>Scheduled messages</DialogTitle
					><DialogDescription
						>Browse pending schedules on the queue or topic, inspect messages and cancel
						by sequence number.</DialogDescription
					></DialogHeader
				><ScheduledMessages
					v-if="scheduledTarget"
					:target="scheduledTarget" /></DialogContent
		></Dialog>
		<Dialog :open="!!composer" @update:open="closeComposer"
			><DialogContent class="message-dialog"
				><DialogHeader
					><DialogTitle>Compose message</DialogTitle
					><DialogDescription
						>Review the destination, drafts and timing before
						sending.</DialogDescription
					></DialogHeader
				><MessageComposer
					v-if="composer"
					:target="composer"
					@sent="closeComposer" /></DialogContent
		></Dialog>
		<Dialog :open="!!action" @update:open="closeAction"
			><DialogContent class="message-dialog"
				><DialogHeader
					><DialogTitle>{{
						action?.kind === 'replay'
							? 'Replay dead-letter message'
							: action?.kind === 'close'
								? 'Close receiver'
								: 'Confirm ' + action?.kind
					}}</DialogTitle
					><DialogDescription>{{ actionText }}</DialogDescription></DialogHeader
				>
				<p class="write-destination">
					{{ sb.connection?.namespace }}<br />{{ source }} / {{ sb.held.subQueue
					}}<br /><span v-if="action?.kind !== 'close'"
						>{{ action?.delivery?.summary.messageId }} · #{{
							action?.delivery?.summary.sequenceNumber
						}}</span
					>
				</p>
				<template v-if="action?.kind === 'dead-letter'"
					><label
						>Reason<Input
							v-model="reason"
							aria-label="Dead-letter reason"
							maxlength="128" /></label
					><label
						>Error description<textarea
							v-model="description"
							aria-label="Dead-letter description"
							maxlength="2048"
							class="commander-textarea"
							rows="3"
						></textarea></label
				></template>
				<template v-if="action?.kind === 'replay'"
					><div class="composer-grid">
						<label
							>Destination type<select
								v-model="destinationKind"
								aria-label="Replay destination type"
								class="commander-select"
							>
								<option value="queue">Queue</option>
								<option value="topic">Topic</option>
							</select></label
						><label
							>Destination name<Input
								v-model="destinationName"
								aria-label="Replay destination name"
								maxlength="260" /></label
						><label
							>Message ID policy<select
								v-model="idPolicy"
								aria-label="Replay message ID policy"
								class="commander-select"
								@change="changePolicy"
							>
								<option value="new">New message ID</option>
								<option value="preserve">Preserve original message ID</option>
							</select></label
						><label
							>Outgoing message ID<Input
								v-model="replayId"
								aria-label="Replay message ID"
								maxlength="128"
								:readonly="idPolicy === 'preserve'"
						/></label>
					</div>
					<p v-if="idPolicy === 'preserve'" class="inspector-warning">
						Duplicate detection may discard the resent message while the transaction
						still completes the source. Preserve an ID only when that behavior is
						intended.
					</p>
					<p v-if="destinationKind === 'topic'" class="inspector-warning">
						A topic replay reaches every matching subscription, not just the source
						subscription. With no matching subscription, the topic retains no copy.
					</p>
					<p class="explorer-note">
						Same namespace only. Transactions must be supported by the entities/tier.
						Failure never falls back to send-then-delete.
					</p>
				</template>
				<div class="explorer-actions">
					<Button
						:disabled="
							!!sb.busy ||
							(action?.kind === 'replay' &&
								(!destinationName.trim() || !replayId.trim())) ||
							(action?.kind === 'dead-letter' && !reason.trim())
						"
						@click="confirm"
						>{{
							action?.kind === 'replay'
								? 'Replay and complete source'
								: action?.kind === 'close'
									? 'Close and let locks expire'
									: 'Confirm ' + action?.kind
						}}</Button
					><Button variant="outline" :disabled="!!sb.busy" @click="closeAction"
						>Cancel action</Button
					>
				</div>
			</DialogContent></Dialog
		>
		<Dialog v-model:open="inspectOpen"
			><DialogContent class="message-inspection-dialog" movable resizable
				><DialogHeader
					><DialogTitle>Received message</DialogTitle
					><DialogDescription
						>{{ source }} / {{ sb.held.subQueue }} · Owned receiver
						snapshot</DialogDescription
					></DialogHeader
				><MessageInspector
					:source="sb.held.target ?? undefined"
					:sub-queue="sb.held.subQueue" /></DialogContent
		></Dialog>
	</section>
</template>
