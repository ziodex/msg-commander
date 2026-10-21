<script setup lang="ts">
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import { serviceBusJob } from '@/features/service-bus/operation-progress'
import { serviceBusApi } from '@/features/service-bus/api'

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
import { useListeners } from '@/features/service-bus/stores/listeners'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import {
	receiveDeleteConfirmation,
	receiveDeleteRequestSchema,
	type ReceiveDeleteResult,
} from '@shared/contracts/service-bus/maintenance'
import {
	subQueueLabel,
	type PeekTarget,
	type MessageSubQueue,
	type MessageSummary,
} from '@shared/service-bus'
import { entityPath } from '@shared/entity-management'
import MessageInspector from './MessageInspector.vue'
const sb = useServiceBus(),
	workspace = useWorkspace(),
	listeners = useListeners(),
	monitor = useNamespaceMonitor()
type Source = { target: PeekTarget; subQueue: MessageSubQueue; sessionId: string }
const visible = ref(false),
	source = ref<Source>(),
	pending = ref<Source>(),
	inspector = ref(false)
const maxMessages = ref(1),
	maxSeconds = ref(20),
	acknowledged = ref(false)
const operationId = ref(''),
	result = ref<ReceiveDeleteResult>(),
	error = ref(''),
	interrupted = ref(false),
	reviewed = ref(false),
	stopping = ref(false)
let generation = 0
const job = computed(() => serviceBusJob(workspace.jobs.find((j) => j.id === operationId.value)))
const running = computed(() => job.value?.status === 'running')
const elapsedMs = ref(0)
let progressTimer: ReturnType<typeof setInterval> | undefined
watch(running, (active) => {
	clearInterval(progressTimer)
	if (!active) return
	const started = Date.now()
	elapsedMs.value = 0
	progressTimer = setInterval(() => {
		elapsedMs.value = Date.now() - started
	}, 250)
})
onBeforeUnmount(() => clearInterval(progressTimer))
const phrase = computed(() =>
	source.value
		? receiveDeleteConfirmation(
				sb.connection?.namespace ?? '',
				source.value.target,
				source.value.subQueue,
				source.value.sessionId,
			)
		: '',
)
const unresolved = computed(() => interrupted.value || (result.value?.uncertain && !reviewed.value))
const blocked = computed(() => !!sb.held.target || listeners.active)
const valid = computed(
	() =>
		acknowledged.value &&
		source.value &&
		receiveDeleteRequestSchema.safeParse({
			id: crypto.randomUUID(),
			connectionId: sb.connection?.connectionId,
			...source.value,
			confirmation: phrase.value,
			maxMessages: maxMessages.value,
			maxSeconds: maxSeconds.value,
		}).success,
)
function reset() {
	operationId.value = ''
	result.value = undefined
	error.value = ''
	interrupted.value = reviewed.value = stopping.value = false
	acknowledged.value = false
}
function open(target: PeekTarget, subQueue: MessageSubQueue, sessionId = '') {
	if (sb.busy || !sb.connection) return
	pending.value = {
		target: { ...target },
		subQueue,
		sessionId: subQueue === 'active' ? sessionId : '',
	}
	if (!operationId.value) {
		source.value = { ...pending.value }
		acknowledged.value = false
	}
	visible.value = true
}
function prepare() {
	if (sb.busy || unresolved.value) return
	reset()
	source.value = pending.value ? { ...pending.value } : undefined
}
watch([phrase, maxMessages, maxSeconds], () => {
	acknowledged.value = false
})
watch(
	() => sb.connection?.connectionId,
	() => {
		generation++
		visible.value = inspector.value = false
		source.value = pending.value = undefined
		reset()
	},
	{ flush: 'sync' },
)
function remember(value: ReceiveDeleteResult) {
	result.value = value
	interrupted.value = false
	monitor.stale = true
}
async function start() {
	if (
		!valid.value ||
		!source.value ||
		operationId.value ||
		sb.busy ||
		blocked.value ||
		!sb.connection
	)
		return
	const ticket = generation,
		connectionId = sb.connection.connectionId
	const input = {
		...source.value,
		target: { ...source.value.target },
		confirmation: phrase.value,
		maxMessages: maxMessages.value,
		maxSeconds: maxSeconds.value,
	}
	sb.busy = 'Receive and delete messages'
	error.value = ''
	try {
		const value = await workspace.perform(
			'Receive and delete messages',
			async (id) => {
				operationId.value = id
				try {
					const response = await serviceBusApi.receiveDelete({
						id,
						connectionId,
						...input,
					})
					if (
						ticket === generation &&
						!response.ok &&
						['OUTCOME_UNKNOWN', 'TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(
							response.error.code,
						)
					)
						interrupted.value = true
					return response
				} catch (cause) {
					if (ticket === generation) interrupted.value = true
					throw cause
				}
			},
			(value) => ({
				status:
					value.status === 'cancelled'
						? 'cancelled'
						: ['unknown', 'failed'].includes(value.status)
							? 'failed'
							: 'completed',
				message: `${value.summary} Receipt: ${value.operationId}`,
			}),
		)
		if (ticket === generation) remember(value)
	} catch (cause) {
		if (ticket === generation)
			error.value = cause instanceof Error ? cause.message : 'Receive-and-delete failed.'
	} finally {
		if (ticket === generation) {
			sb.busy = ''
			void monitor.refresh()
		}
	}
}
async function check() {
	if (!sb.connection || sb.busy || !operationId.value) return
	const ticket = generation,
		connectionId = sb.connection.connectionId,
		current = operationId.value
	sb.busy = 'Check receive-and-delete result'
	try {
		const value = await workspace.perform('Check receive-and-delete result', (id) =>
			serviceBusApi.getReceiveDeleteResult({ id, connectionId, operationId: current }),
		)
		if (ticket !== generation) return
		if (value) {
			error.value = ''
			remember(value)
		} else
			error.value =
				'No receipt is available. This does not prove that nothing was consumed. Inspect the source before reconnecting.'
	} catch (cause) {
		if (ticket === generation)
			error.value = cause instanceof Error ? cause.message : 'Result unavailable.'
	} finally {
		if (ticket === generation) sb.busy = ''
	}
}
async function cancel() {
	stopping.value = true
	await workspace.cancel(operationId.value)
}
async function inspect(message: MessageSummary) {
	inspector.value = true
	await sb.inspect(message)
}
defineExpose({ open })
</script>
<template>
	<Button
		v-if="operationId"
		variant="outline"
		size="sm"
		:disabled="!!sb.busy && !running"
		@click="visible = true"
		>Receive &amp; delete result</Button
	>
	<Dialog :open="visible" @update:open="!running && (visible = $event)">
		<DialogContent
			class="message-dialog receive-delete-dialog"
			:show-close-button="!running"
			@escape-key-down="running && $event.preventDefault()"
			@interact-outside="running && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Receive &amp; delete</DialogTitle
				><DialogDescription
					>Consume messages permanently and inspect the copies returned to this
					app.</DialogDescription
				></DialogHeader
			>
			<template v-if="source">
				<p class="write-destination">
					{{ sb.connection?.namespace }}<br />{{ entityPath(source.target) }} ·
					<strong>{{ subQueueLabel(source.subQueue) }}</strong
					><span v-if="result?.sessionId"> · Session {{ result.sessionId }}</span>
				</p>
				<p class="inspector-warning">
					Messages are deleted as Azure sends them, before you inspect them. There is no
					complete, abandon or undo. A failed or cancelled transfer may lose messages that
					never reach this app.
				</p>
				<template v-if="!operationId">
					<p class="explorer-note">
						Receive one at a time, up to the count or time limit. Stops early after an
						idle wait. New arrivals may be included; locked, deferred and scheduled
						messages may remain.
					</p>
					<p class="explorer-note">
						Copies are held in memory (64 MiB total). An oversized message is still
						consumed and may not be inspectable. Save needed messages before another run
						or disconnecting.
					</p>
					<p v-if="blocked" class="inspector-warning">
						Stop the listener and close the current message or session receiver first.
					</p>
					<div class="explorer-actions">
						<label
							>Maximum messages<Input
								v-model.number="maxMessages"
								aria-label="Receive-and-delete count"
								type="number"
								min="1"
								max="100"
						/></label>
						<label
							>Time limit (seconds)<Input
								v-model.number="maxSeconds"
								aria-label="Receive-and-delete time limit"
								type="number"
								min="1"
								max="600"
						/></label>
					</div>
					<label v-if="source.subQueue === 'active'"
						>Session ID (required for session-enabled entities)<Input
							v-model="source.sessionId"
							aria-label="Receive-and-delete session ID"
							maxlength="128"
					/></label>
					<label class="confirm-check"
						><input v-model="acknowledged" type="checkbox" />I understand messages are
						permanently consumed and may be lost before inspection.</label
					>

					<Button
						variant="destructive"
						:disabled="!valid || !!sb.busy || blocked"
						@click="start"
						>Receive &amp; delete permanently</Button
					>
				</template>
				<div v-if="running" role="status" class="inspector-warning">
					<LoadingIndicator label="Receiving and deleting messages…" :announce="false" />
					<p>
						{{ job?.receiveDelete?.received ?? 0 }} / {{ maxMessages }} messages
						returned and consumed ·
						{{
							Math.floor(
								Math.max(elapsedMs, job?.receiveDelete?.elapsedMs ?? 0) / 1000,
							)
						}}
						seconds ·
						{{ job?.receiveDelete?.phase ?? 'starting' }}
					</p>
					<Button variant="outline" :disabled="stopping" @click="cancel">{{
						stopping ? 'Stopping…' : 'Cancel receive & delete'
					}}</Button>
					<p>
						Cancellation stops further receives. An in-flight transfer may still consume
						messages.
					</p>
				</div>
				<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
				<template v-if="interrupted">
					<p class="inspector-warning">
						The final result is unknown. At least
						{{ job?.receiveDelete?.received ?? 0 }} messages were returned and consumed.
						Additional messages may have been lost. Nothing was retried.
					</p>
					<Button :disabled="!!sb.busy" variant="outline" @click="check"
						>Check receive-and-delete result</Button
					>
				</template>
				<section v-if="result" aria-label="Receive-and-delete result">
					<p role="status">{{ result.summary }}</p>
					<p class="explorer-note">
						{{ result.status }} · {{ (result.elapsedMs / 1000).toFixed(1) }} seconds ·
						Receipt
						{{ result.operationId }}
					</p>
					<p v-if="result.cleanupWarning" class="inspector-warning">
						{{ result.cleanupWarning }}
					</p>
					<p v-if="result.uncertain" class="inspector-warning">
						The returned-message count is a lower bound. The total consumed is unknown.
					</p>
					<label v-if="result.uncertain" class="confirm-check"
						><input v-model="reviewed" type="checkbox" />I have reviewed the uncertain
						result before starting another receive.</label
					>
					<div class="table-scroll">
						<table class="message-table">
							<thead>
								<tr>
									<th>Message</th>
									<th>Sequence</th>
									<th>Bytes</th>
									<th>Copy</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="item in result.items" :key="item.sequenceNumber">
									<td>{{ item.messageId || '(no ID)' }}</td>
									<td>{{ item.sequenceNumber }}</td>
									<td>{{ item.bodySize }}</td>
									<td>
										<Button
											v-if="item.snapshotId"
											size="sm"
											variant="outline"
											:disabled="!!sb.busy"
											@click="inspect(item)"
											>Inspect consumed message</Button
										><span v-else>{{ item.inspectionWarning }}</span>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>
				<Button
					v-if="operationId && !running"
					variant="outline"
					:disabled="!!sb.busy || unresolved"
					@click="prepare"
					>Prepare another receive</Button
				>
			</template>
		</DialogContent>
	</Dialog>
	<Dialog :open="inspector" @update:open="inspector = $event"
		><DialogContent class="message-inspection-dialog" movable resizable
			><DialogHeader
				><DialogTitle>Inspect consumed message</DialogTitle
				><DialogDescription
					>This message was permanently consumed. Save the local copy if
					needed.</DialogDescription
				></DialogHeader
			>
			<p v-if="sb.error" class="error-banner">{{ sb.error }}</p>
			<MessageInspector /></DialogContent
	></Dialog>
</template>
<style scoped>
.receive-delete-dialog {
	max-height: 90vh;
	overflow-y: auto;
}
.confirm-check {
	display: flex;
	align-items: flex-start;
	gap: 0.6rem;
	margin: 0.7rem 0;
}
.confirmation-phrase {
	display: block;
	overflow-wrap: anywhere;
	user-select: all;
	margin: 0.4rem 0;
}
.table-scroll {
	overflow: auto;
	max-height: 34vh;
	margin: 1rem 0;
}
table {
	width: 100%;
	text-align: left;
}
th,
td {
	padding: 0.5rem;
	border-bottom: 1px solid var(--border);
}
</style>
