<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import { useListeners } from '@/features/service-bus/stores/listeners'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { entityPath } from '@shared/entity-management'
import { listenerStartSchema, type ListenerItem, type ListenerSettle } from '@shared/listeners'
import type { PeekTarget } from '@shared/service-bus'
import MessageInspector from './MessageInspector.vue'
const listener = useListeners(),
	sb = useServiceBus()
const opened = ref(false),
	configuring = ref(false),
	source = ref<PeekTarget>()
const mode = ref<'manual' | 'auto-complete'>('manual'),
	sessionId = ref('')
const sessionMode = ref<'single' | 'next-available'>('single'),
	maxConcurrentSessions = ref(2),
	sessionIdleSeconds = ref(5)
const maxMessages = ref(1000),
	maxSeconds = ref(3600),
	maxLockSeconds = ref(300)
const acknowledged = ref(false),
	reviewedUnknown = ref(false),
	inspectorOpen = ref(false)
const action = ref<{ item: ListenerItem; type: ListenerSettle['action'] }>()
const reason = ref(''),
	description = ref('')
const options = computed(() => ({
	target: source.value!,
	mode: mode.value,
	sessionId: sessionMode.value === 'next-available' ? '' : sessionId.value,
	sessionMode: sessionMode.value,
	maxConcurrentSessions: sessionMode.value === 'next-available' ? maxConcurrentSessions.value : 1,
	sessionIdleSeconds: sessionIdleSeconds.value,
	maxMessages: maxMessages.value,
	maxSeconds: maxSeconds.value,
	maxLockSeconds: maxLockSeconds.value,
}))
const valid = computed(
	() =>
		!!sb.connection &&
		!!source.value &&
		listenerStartSchema.safeParse({
			...options.value,
			id: sb.connection.connectionId,
			connectionId: sb.connection.connectionId,
		}).success &&
		acknowledged.value &&
		(listener.state?.status !== 'unknown' || reviewedUnknown.value),
)
const rate = computed(() =>
	listener.state
		? (listener.state.received / Math.max(1, listener.state.elapsedMs / 1000)).toFixed(1)
		: '0.0',
)
function open(target?: PeekTarget) {
	const selected =
		target ?? (sb.selected?.target.kind !== 'topic' ? sb.selected?.target : undefined)
	opened.value = true
	if (!listener.active && selected) {
		source.value = { ...selected }
		configuring.value = true
		mode.value = 'manual'
		sessionMode.value = 'single'
		sessionId.value = ''
		acknowledged.value = false
		reviewedUnknown.value = false
	} else configuring.value = false
}
function show() {
	if (!listener.state) open()
	else {
		opened.value = true
		configuring.value = false
	}
}
defineExpose({ open })
watch(
	[
		mode,
		sessionId,
		sessionMode,
		maxConcurrentSessions,
		sessionIdleSeconds,
		maxMessages,
		maxSeconds,
		maxLockSeconds,
	],
	() => {
		acknowledged.value = false
	},
)
watch(
	() => sb.connection?.connectionId,
	() => {
		opened.value = false
		action.value = undefined
		inspectorOpen.value = false
	},
)
async function start() {
	if (!valid.value || listener.busy || sb.busy || sb.held.target || listener.active) return
	if (await listener.start(options.value)) configuring.value = false
}
async function inspect(item: ListenerItem) {
	inspectorOpen.value = true
	await sb.inspect(item.summary)
}
function prepare(item: ListenerItem, type: ListenerSettle['action']) {
	action.value = { item, type }
	reason.value = ''
	description.value = ''
}
async function settle() {
	if (!action.value) return
	const request = action.value
	if (
		await listener.settle({
			deliveryId: request.item.deliveryId,
			action: request.type,
			reason: reason.value,
			description: description.value,
		})
	)
		action.value = undefined
}
</script>
<template>
	<div class="listener-toolbar">
		<div v-if="listener.state">
			<strong>Listener · {{ entityPath(listener.state.target) }}</strong>
			<span
				>{{ listener.state.status }} · {{ listener.state.received }} received ·
				{{ listener.state.completed }} completed</span
			>
		</div>
		<div class="explorer-actions">
			<Button
				variant="outline"
				size="sm"
				:disabled="!listener.state && (!sb.selected || sb.selected.target.kind === 'topic')"
				@click="show"
				>{{ listener.state ? 'View listener' : 'Listen for messages' }}</Button
			>
			<Button
				v-if="listener.active"
				variant="outline"
				size="sm"
				:disabled="listener.busy || listener.state?.status === 'stopping'"
				@click="listener.stop()"
				>Stop listener</Button
			>
		</div>
	</div>
	<Dialog v-model:open="opened">
		<DialogContent class="message-dialog listener-dialog">
			<DialogHeader
				><DialogTitle>Background message listener</DialogTitle
				><DialogDescription
					>Receive from one queue or subscription while continuing other work. Closing
					this window keeps the listener running.</DialogDescription
				></DialogHeader
			>
			<p v-if="listener.error" class="form-error" role="alert">{{ listener.error }}</p>
			<p v-if="listener.stale" class="inspector-warning">
				Status may be stale. Refresh before repeating an action; an in-flight settlement may
				still succeed.
			</p>
			<template v-if="configuring && source">
				<div class="connection-form listener-options">
					<p class="write-destination">
						<strong>{{ sb.connection?.namespace }}</strong
						><span>{{ entityPath(source) }} / Main messages</span>
					</p>
					<p v-if="sb.held.target" class="inspector-warning">
						Close the current message or session receiver before starting a listener.
					</p>
					<label
						>Settlement mode<select
							v-model="mode"
							class="commander-select"
							aria-label="Listener settlement mode"
						>
							<option value="manual">Manual — review each message</option>
							<option value="auto-complete">
								Automatically complete received messages
							</option>
						</select></label
					>
					<p class="explorer-note" v-if="mode === 'manual'">
						{{
							sessionMode === 'next-available'
								? 'One message per session is held at a time.'
								: 'One message is held at a time.'
						}}
						Inspect it, then complete, abandon, dead-letter or defer it. Locks renew
						automatically within the review time limit.
					</p>
					<p class="inspector-warning" v-else>
						Automatic completion removes received messages from the source. A local
						history entry does not mean your application processed the message.
						Confirmed completions cannot be undone.
					</p>
					<label
						>Session selection<select
							v-model="sessionMode"
							class="commander-select"
							aria-label="Listener session selection"
						>
							<option value="single">Regular source or one selected session</option>
							<option value="next-available">
								Automatically select available sessions
							</option>
						</select></label
					>
					<template v-if="sessionMode === 'next-available'">
						<p class="explorer-note">
							For session-enabled queues and subscriptions. Workers accept unlocked
							sessions with available messages and release idle sessions. The message
							and run-time limits apply to the whole job. Session state is preserved.
						</p>
						<div class="composer-grid">
							<label
								>Maximum concurrent sessions<Input
									v-model.number="maxConcurrentSessions"
									type="number"
									min="1"
									max="8"
									aria-label="Listener concurrent sessions"
							/></label>
							<label
								>Release idle session after (seconds)<Input
									v-model.number="sessionIdleSeconds"
									type="number"
									min="1"
									max="30"
									aria-label="Listener session idle time"
							/></label>
						</div>
					</template>
					<label v-else
						>Session ID (for session-enabled sources)<Input
							v-model="sessionId"
							aria-label="Listener session ID"
							maxlength="128"
					/></label>
					<div class="composer-grid">
						<label
							>Maximum messages<Input
								v-model.number="maxMessages"
								type="number"
								min="1"
								:max="mode === 'manual' ? 1000 : 100000"
								aria-label="Listener maximum messages"
						/></label>
						<label
							>Run time (seconds)<Input
								v-model.number="maxSeconds"
								type="number"
								min="1"
								max="86400"
								aria-label="Listener run time"
						/></label>
						<label v-if="mode === 'manual'"
							>Review time per message (seconds)<Input
								v-model.number="maxLockSeconds"
								type="number"
								min="1"
								max="3600"
								aria-label="Listener review time"
						/></label>
					</div>
					<p class="explorer-note">
						Shared history retains up to 100 deliveries within 16 MiB of body/property
						data; pending messages are retained for review. Start/stop affects message
						locks and delivery counts. Unsettled messages may remain locked until
						expiry.
						{{
							sessionMode === 'next-available'
								? 'Stop cancels every worker and waits for receiver cleanup. A failure or uncertain settlement stops the whole job; already dispatched settlements may still succeed.'
								: 'A session listener holds the selected session until stopped or limited.'
						}}
					</p>
					<label v-if="listener.state?.status === 'unknown'" class="listener-ack"
						><input type="checkbox" v-model="reviewedUnknown" />I reviewed the source
						after the previous uncertain settlement.</label
					>
					<label class="listener-ack"
						><input type="checkbox" v-model="acknowledged" />I reviewed the source,
						settlement mode and limits.</label
					>
					<Button
						:variant="mode === 'auto-complete' ? 'destructive' : 'default'"
						:disabled="
							!valid ||
							listener.busy ||
							!!sb.busy ||
							!!sb.held.target ||
							listener.active
						"
						@click="start"
						>Start listener</Button
					>
				</div>
			</template>
			<template v-else-if="listener.state">
				<div class="write-destination">
					<strong>{{ sb.connection?.namespace }}</strong
					><span
						>{{ entityPath(listener.state.target) }} / Main messages{{
							listener.state.sessionId ? ' · Session ' + listener.state.sessionId : ''
						}}</span
					>
				</div>
				<div class="listener-counters" aria-label="Listener counters">
					<span
						><strong>{{ listener.state.received }}</strong> received</span
					><span
						><strong>{{ listener.state.completed }}</strong> completed</span
					><span
						><strong>{{ listener.state.failed }}</strong> failed</span
					><span
						><strong>{{ listener.state.uncertain }}</strong> uncertain</span
					><span
						><strong>{{ rate }}/s</strong> received average</span
					>
				</div>
				<p role="status">{{ listener.state.status }} · {{ listener.state.summary }}</p>
				<p class="explorer-note">
					{{
						listener.state.mode === 'manual'
							? 'Manual settlement'
							: 'Automatic completion'
					}}
					· {{ listener.state.renewed }} lock renewals ·
					{{ listener.state.abandoned }} abandoned ·
					{{ listener.state.deadLettered }} dead-lettered ·
					{{ listener.state.deferred }} deferred ·
					{{ listener.state.items.length }} retained ·
					{{ listener.state.evicted }} evicted
				</p>
				<div class="explorer-actions">
					<Button
						v-if="listener.active"
						variant="outline"
						:disabled="listener.busy || listener.state.status === 'stopping'"
						@click="listener.stop()"
						>Stop listener</Button
					>
					<Button variant="outline" :disabled="listener.busy" @click="listener.refresh()"
						>Refresh listener</Button
					>
					<Button
						v-if="!listener.active"
						variant="outline"
						:disabled="listener.busy"
						@click="open(listener.state.target)"
						>Configure new listener</Button
					>
				</div>
				<section
					v-if="listener.state.sessionMode === 'next-available'"
					class="session-progress"
					aria-label="Session progress"
				>
					<h3>Session progress</h3>
					<p role="status">
						{{ listener.state.activeSessions }} /
						{{ listener.state.maxConcurrentSessions }} sessions owned ·
						{{ listener.state.acceptingSessions }} accepting ·
						{{ listener.state.received }} / {{ listener.state.maxMessages }} messages ·
						{{ Math.floor(listener.state.elapsedMs / 1000) }} /
						{{ listener.state.maxSeconds }} seconds
					</p>
					<p class="explorer-note">
						{{ listener.state.sessionAcquisitions }} session acquisitions ·
						{{ listener.state.sessionHistoryEvicted }} older session rows evicted.
						Totals include evicted history. Limits count deliveries, including
						redeliveries after abandonment.
					</p>
					<p v-if="!listener.state.sessions.length" class="explorer-note">
						Waiting for an unlocked session with available messages. An idle wait does
						not prove the source is empty.
					</p>
					<div v-else class="session-progress-table">
						<table>
							<thead>
								<tr>
									<th>Session</th>
									<th>State</th>
									<th>Received</th>
									<th>Settled</th>
									<th>Pending</th>
									<th>Renewals</th>
									<th>Uncertain</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="session in listener.state.sessions"
									:key="session.sessionId"
									:aria-label="'Session ' + session.sessionId"
								>
									<td class="session-name">{{ session.sessionId }}</td>
									<td>
										{{ session.status }}<small>{{ session.summary }}</small
										><small v-if="session.lockedUntil"
											>Lock expires {{ session.lockedUntil }}</small
										>
									</td>
									<td>{{ session.received }}</td>
									<td>
										{{
											session.completed +
											session.abandoned +
											session.deadLettered +
											session.deferred
										}}
									</td>
									<td>{{ session.pending }}</td>
									<td>{{ session.renewed }}</td>
									<td>{{ session.uncertain }}</td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>
				<div class="listener-history" aria-label="Listener messages">
					<p v-if="!listener.state.items.length" class="explorer-empty">
						{{ listener.active ? 'Waiting for messages…' : 'No messages retained.' }}
					</p>
					<article
						v-for="item in listener.state.items"
						:key="item.deliveryId"
						class="held-message"
						:aria-label="'Listener message ' + item.summary.messageId"
					>
						<div class="explorer-heading">
							<div class="message-identity">
								<strong class="message-label-text">{{
									item.summary.subject?.trim() ? item.summary.subject : 'No label'
								}}</strong>
								<p class="message-identity-meta">
									<span>{{ item.summary.messageId ?? '(No ID)' }}</span>
									<span>#{{ item.summary.sequenceNumber }}</span>
								</p>
							</div>
							<span>{{ item.state }}</span>
						</div>
						<p v-if="item.summary.sessionId" class="explorer-note">
							Session {{ item.summary.sessionId }}
						</p>
						<p v-if="item.state === 'active'" class="explorer-note">
							Lock expires {{ item.lockedUntil }}. The broker determines lock
							validity.
						</p>
						<div class="explorer-actions">
							<Button
								size="sm"
								variant="outline"
								:disabled="!!sb.busy || !item.summary.snapshotId"
								@click="inspect(item)"
								>Inspect listener message</Button
							>
							<template
								v-if="
									item.state === 'active' &&
									listener.state.mode === 'manual' &&
									listener.state.status === 'running'
								"
							>
								<Button
									v-for="type in [
										'complete',
										'abandon',
										'dead-letter',
										'defer',
									] as const"
									:key="type"
									size="sm"
									variant="outline"
									:disabled="listener.busy || listener.stale"
									@click="prepare(item, type)"
									>{{
										type === 'dead-letter'
											? 'Dead-letter'
											: type[0].toUpperCase() + type.slice(1)
									}}</Button
								>
							</template>
						</div>
					</article>
				</div>
			</template>
			<p v-else class="explorer-note">
				Select a queue or subscription, or use its Listen for messages context menu.
			</p>
		</DialogContent>
	</Dialog>
	<Dialog :open="!!action" @update:open="!listener.busy && (action = undefined)">
		<DialogContent
			:show-close-button="!listener.busy"
			@escape-key-down="listener.busy && $event.preventDefault()"
			@interact-outside="listener.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Settle listener message</DialogTitle
				><DialogDescription
					>{{ action?.type }} · {{ action?.item.summary.messageId }} ·
					{{ listener.state ? entityPath(listener.state.target) : ''
					}}{{
						action?.item.summary.sessionId
							? ' · Session ' + action.item.summary.sessionId
							: ''
					}}</DialogDescription
				></DialogHeader
			>
			<p v-if="action?.type === 'complete'">
				Complete permanently removes this message from the source.
			</p>
			<p v-if="action?.type === 'abandon'">
				Abandon releases the message for redelivery. This listener may receive it again.
			</p>
			<p v-if="action?.type === 'defer'">
				Sequence {{ action.item.summary.sequenceNumber }} is recorded after confirmation for
				retrieval during this app session.
			</p>
			<template v-if="action?.type === 'dead-letter'"
				><Input
					v-model="reason"
					aria-label="Listener dead-letter reason"
					placeholder="Reason"
					maxlength="128" /><Input
					v-model="description"
					aria-label="Listener dead-letter description"
					placeholder="Description"
					maxlength="4096"
			/></template>
			<p v-if="listener.error" role="alert">{{ listener.error }}</p>
			<Button :disabled="listener.busy || !listener.active || listener.stale" @click="settle"
				>Confirm {{ action?.type }}</Button
			>
		</DialogContent>
	</Dialog>
	<Dialog v-model:open="inspectorOpen"
		><DialogContent class="message-inspection-dialog" movable resizable
			><DialogHeader
				><DialogTitle>Inspect listener message</DialogTitle
				><DialogDescription
					>Captured bytes and properties. History can evict older snapshots while
					listening.</DialogDescription
				></DialogHeader
			><MessageInspector />
			<p v-if="sb.error" role="alert">{{ sb.error }}</p></DialogContent
		></Dialog
	>
</template>

<style scoped>
.listener-options {
	gap: 12px;
}
.listener-options .explorer-note {
	margin: 2px 0;
}
.session-progress {
	min-width: 0;
}
.session-progress-table {
	max-height: 16rem;
	overflow: auto;
}
.session-progress table {
	width: 100%;
	text-align: left;
	font-size: 0.8rem;
}
.session-progress th,
.session-progress td {
	padding: 0.5rem;
	border-bottom: 1px solid var(--border);
	vertical-align: top;
}
.session-progress small {
	display: block;
	max-width: 20rem;
	color: var(--muted-foreground);
}
.session-name {
	overflow-wrap: anywhere;
	min-width: 7rem;
	max-width: 12rem;
}
</style>
