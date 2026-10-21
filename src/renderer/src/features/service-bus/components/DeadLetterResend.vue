<script setup lang="ts">
import { serviceBusJob } from '@/features/service-bus/operation-progress'
import { serviceBusApi } from '@/features/service-bus/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { resendRequestSchema, type ResendResult } from '@shared/contracts/service-bus/maintenance'
import { entityPath } from '@shared/entity-management'
import { subQueueLabel, type PeekTarget, type DeadLetterSubQueue } from '@shared/service-bus'
import type { SendTarget } from '@shared/message-operations'
const props = defineProps<{ source: PeekTarget; subQueue: DeadLetterSubQueue }>()
const sb = useServiceBus(),
	workspace = useWorkspace()
const destinationKind = ref<'queue' | 'topic'>(props.source.kind === 'queue' ? 'queue' : 'topic')
const destinationName = ref(
	props.source.kind === 'queue' ? props.source.name : props.source.topicName,
)
const destination = computed<SendTarget>(() => ({
	kind: destinationKind.value,
	name: destinationName.value,
}))
const destinationProfileId = ref('')
const destinationProfiles = computed(() =>
	workspace.profiles.filter(
		(p) =>
			p.service === 'service-bus' &&
			p.namespace.toLowerCase() !== sb.connection?.namespace.toLowerCase(),
	),
)
const destinationProfile = computed(() =>
	destinationProfiles.value.find((p) => p.id === destinationProfileId.value),
)
const crossNamespace = computed(() => !!destinationProfileId.value)
const destinationNamespace = computed(() =>
	crossNamespace.value ? destinationProfile.value?.namespace : sb.connection?.namespace,
)
const acknowledgeNonAtomic = ref(false),
	savingReceipt = ref(false),
	receiptMessage = ref('')
const needsReview = (value?: ResendResult) =>
	!!value && (value.status === 'unknown' || value.copiedNotRemoved > 0)
const destinationOptions = computed(() =>
	crossNamespace.value
		? {
				destinationProfileId: destinationProfileId.value,
				destinationNamespace: destinationNamespace.value,
				acknowledgeNonAtomic: acknowledgeNonAtomic.value,
			}
		: {},
)
async function openDeviceLogin() {
	const response = await serviceBusApi.openDeviceLogin()
	if (!response.ok) receiptMessage.value = response.error.message
}
async function saveReceipt(value: ResendResult) {
	if (!sb.connection || savingReceipt.value) return
	savingReceipt.value = true
	receiptMessage.value = ''
	try {
		const response = await serviceBusApi.saveResendReceipt({
			id: crypto.randomUUID(),
			connectionId: sb.connection.connectionId,
			operationId: value.operationId,
		})
		receiptMessage.value = response.ok
			? response.value.cancelled
				? 'Receipt export cancelled.'
				: `Saved ${response.value.fileName}`
			: response.error.message
	} catch {
		receiptMessage.value = 'The receipt could not be saved. Nothing was resent.'
	} finally {
		savingReceipt.value = false
	}
}
const mode = ref<'keep' | 'remove'>('keep'),
	idPolicy = ref<'new' | 'preserve'>('new')
const maxMessages = ref(100),
	maxSeconds = ref(60),
	acknowledged = ref(false),
	reviewedUnknown = ref(false)
const attempted = ref(false),
	stopping = ref(false)
const job = computed(() =>
	serviceBusJob(workspace.jobs.find((item) => item.id === sb.resendOperationId)),
)
const running = computed(() => attempted.value && job.value?.status === 'running')
const result = computed(() => (attempted.value ? sb.resendResult : undefined))
const previous = computed(() => (!attempted.value ? sb.resendResult : undefined))
const valid = computed(
	() =>
		!!sb.connection &&
		acknowledged.value &&
		(!needsReview(previous.value) || reviewedUnknown.value) &&
		resendRequestSchema.safeParse({
			id: sb.connection.connectionId,
			connectionId: sb.connection.connectionId,
			source: props.source,
			subQueue: props.subQueue,
			destination: destination.value,
			...destinationOptions.value,
			mode: mode.value,
			idPolicy: idPolicy.value,
			maxMessages: maxMessages.value,
			maxSeconds: maxSeconds.value,
		}).success,
)
watch(
	[
		destinationKind,
		destinationName,
		destinationProfileId,
		destinationNamespace,
		mode,
		idPolicy,
		maxMessages,
		maxSeconds,
	],
	() => {
		acknowledgeNonAtomic.value = false
		acknowledged.value = false
	},
)
async function start() {
	if (!valid.value || attempted.value || sb.busy || sb.resendInterrupted || sb.held.target) return
	attempted.value = true
	await sb.resendDeadLetters({
		source: { ...props.source },
		subQueue: props.subQueue,
		destination: { ...destination.value },
		...destinationOptions.value,
		mode: mode.value,
		idPolicy: idPolicy.value,
		maxMessages: maxMessages.value,
		maxSeconds: maxSeconds.value,
	})
}
async function cancel() {
	stopping.value = true
	await workspace.cancel(sb.resendOperationId)
}
</script>
<template>
	<div class="resend-manager connection-form">
		<p class="write-destination">
			<strong>{{ sb.connection?.namespace }}</strong
			><span>Source: {{ entityPath(source) }} / {{ subQueueLabel(subQueue) }}</span>
		</p>
		<p v-if="subQueue === 'transfer-dead-letter'" class="inspector-warning">
			Review the forwarding destination and failure before resending. The suggested
			destination is the source queue or parent topic; choose a different destination if
			needed. Forwarding rules still apply and may cause the message to return here.
		</p>
		<template v-if="!attempted">
			<p v-if="sb.held.target" class="inspector-warning">
				Close the current message or session receiver before resending dead letters.
			</p>
			<p v-if="sb.resendInterrupted" class="inspector-warning">
				The previous resend was interrupted. Check its result before starting another; some
				sends may already have succeeded.
			</p>
			<Button
				v-if="sb.resendInterrupted"
				variant="outline"
				:disabled="!!sb.busy"
				@click="sb.checkResendResult()"
				>Check resend result</Button
			>
			<details v-if="previous" class="resend-previous" :open="needsReview(previous)">
				<summary>
					Previous resend: {{ previous.status }} · {{ previous.sent }} confirmed
				</summary>
				<p>
					{{ previous.sourceNamespace }} / {{ entityPath(previous.source) }} /
					{{ subQueueLabel(previous.subQueue) }} → {{ previous.destinationNamespace }} /
					{{ previous.destination.kind }}/{{ previous.destination.name }}
				</p>
				<p>{{ previous.summary }}</p>
				<p v-if="previous.outgoingMessageId">
					Last outgoing ID: <code>{{ previous.outgoingMessageId }}</code> · source
					sequence
					{{ previous.sourceSequenceNumber }}
				</p>
				<Button variant="outline" :disabled="savingReceipt" @click="saveReceipt(previous)"
					>Save previous resend receipt</Button
				>
				<label v-if="needsReview(previous)" class="purge-ack"
					><input v-model="reviewedUnknown" type="checkbox" />{{
						previous.status === 'unknown'
							? 'I have reviewed the source and destination after the uncertain result.'
							: 'I have reviewed the confirmed copies without source removal before another resend.'
					}}</label
				>
			</details>
			<label
				>Destination connection<select
					v-model="destinationProfileId"
					class="commander-select"
					aria-label="Resend destination connection"
				>
					<option value="">Current namespace — {{ sb.connection?.namespace }}</option>
					<option
						v-for="profile in destinationProfiles"
						:key="profile.id"
						:value="profile.id"
					>
						{{ profile.name }} — {{ profile.namespace }}
					</option>
				</select></label
			>
			<p v-if="!destinationProfiles.length" class="explorer-note">
				To recover into another namespace, save a Service Bus connection first, then
				reconnect to this source.
			</p>
			<p v-if="crossNamespace" class="write-destination">
				<strong
					>Destination:
					{{ destinationNamespace ?? 'Select the destination connection again' }}</strong
				><span
					>The saved connection is opened for this job only. Source browsing stays
					connected here.</span
				>
			</p>
			<p v-if="crossNamespace" class="inspector-warning">
				Cross-namespace recovery uses separate sends and source completions. It can leave
				duplicates. Keep originals unless you intend to remove each one after an
				acknowledged send. The time limit includes destination sign-in.
			</p>
			<div class="composer-grid">
				<label
					>Destination type<select
						v-model="destinationKind"
						class="commander-select"
						aria-label="Resend destination type"
					>
						<option value="queue">Queue</option>
						<option value="topic">Topic</option>
					</select></label
				>
				<label
					>Destination name<Input
						v-model="destinationName"
						aria-label="Resend destination name"
						maxlength="260"
				/></label>
			</div>
			<p v-if="destinationKind === 'topic'" class="inspector-warning">
				Sending to a topic can deliver a new copy to every matching subscription, including
				subscriptions other than the source. Subscription filters and rule actions apply
				again.
			</p>
			<fieldset class="resend-mode">
				<legend>Original dead-letter messages</legend>
				<label
					><input v-model="mode" type="radio" value="keep" name="resend-mode" />Keep
					originals in the {{ subQueueLabel(subQueue).toLowerCase() }} queue</label
				>
				<label
					><input v-model="mode" type="radio" value="remove" name="resend-mode" />Remove
					originals after successful resend</label
				>
			</fieldset>
			<p v-if="mode === 'keep'" class="explorer-note">
				Reads without locking or settling originals. Repeating this action can create
				additional copies. Other consumers may change the source during the scan.
			</p>
			<p v-else-if="!crossNamespace" class="inspector-warning">
				Each resend and removal commit together in a broker transaction. Only successfully
				transferred originals are removed; this never purges the whole DLQ. Requires
				Standard/Premium transaction support. A failed or uncertain transfer stops the job.
			</p>
			<label v-if="crossNamespace && mode === 'remove'" class="purge-ack"
				><input v-model="acknowledgeNonAtomic" type="checkbox" />I understand a confirmed
				destination send can remain without source removal, and another resend can duplicate
				it.</label
			>
			<label
				>Message IDs<select
					v-model="idPolicy"
					class="commander-select"
					aria-label="Resend message ID policy"
				>
					<option value="new">Generate new IDs</option>
					<option value="preserve">Preserve original IDs</option>
				</select></label
			>
			<p v-if="idPolicy === 'preserve'" class="inspector-warning">
				Duplicate detection can acknowledge and discard a resend with the same message ID.
				In remove mode, the original can still be removed. Preserve IDs only when this
				behavior is intended.
			</p>
			<div class="composer-grid">
				<label
					>Maximum messages<Input
						v-model.number="maxMessages"
						type="number"
						min="1"
						max="1000"
						aria-label="Maximum resend messages"
				/></label>
				<label
					>Time limit (seconds)<Input
						v-model.number="maxSeconds"
						type="number"
						min="1"
						max="600"
						aria-label="Resend time limit"
				/></label>
			</div>
			<details class="resend-details">
				<summary>Message properties, limits and cancellation</summary>
				<p class="explorer-note">
					Original body bytes, session ID and compatible properties are preserved. The
					original TTL starts again; old scheduling and dead-letter diagnostics are
					removed. Binary application properties are unsupported and stop the job without
					resending that message.
				</p>
				<p class="explorer-note">
					Fix the cause first: unchanged messages can return to the DLQ. New arrivals may
					be included. Stops if an ID already resent by this job appears again. Locked
					messages may remain in remove mode. Cancellation stops further work; an
					in-flight send or transaction may still commit. Unsettled originals may remain
					locked until expiry after cancellation or failure.
				</p>
			</details>
			<label class="purge-ack"
				><input v-model="acknowledged" type="checkbox" />I have reviewed the destination,
				message IDs and original-message behavior.</label
			>
			<Button
				:variant="mode === 'remove' ? 'destructive' : 'default'"
				:disabled="!valid || !!sb.busy || !!sb.held.target || sb.resendInterrupted"
				@click="start"
				>Start resend</Button
			>
		</template>
		<section v-else aria-label="Resend result" aria-live="polite">
			<p>
				Destination: {{ result?.destinationNamespace ?? destinationNamespace }} /
				{{ destination.kind }}/{{ destination.name }} ·
				{{ mode === 'keep' ? 'Keep originals' : 'Remove originals after resend' }}
			</p>
			<p v-if="running">
				{{
					stopping
						? 'Stopping… Waiting for the broker result.'
						: 'Resending dead-letter messages…'
				}}
			</p>
			<p v-if="job?.resend || result" class="purge-count">
				<strong>{{ result?.sent ?? job?.resend?.sent ?? 0 }}</strong> resends confirmed ·
				{{ result?.removed ?? job?.resend?.removed ?? 0 }} originals removed ·
				{{ result?.uncertain ?? job?.resend?.uncertain ?? 0 }} uncertain
			</p>
			<p v-if="running && job?.resend" class="explorer-note">
				{{ job.resend.phase }} · {{ Math.round(job.resend.elapsedMs / 1000) }} seconds
			</p>
			<p v-if="running && job?.code" class="inspector-warning">
				Destination sign-in code: <code>{{ job.code }}</code>
				<Button variant="outline" @click="openDeviceLogin()">Open Microsoft sign-in</Button>
			</p>
			<progress v-if="running" aria-label="Resend progress" />
			<Button v-if="running" variant="outline" :disabled="stopping" @click="cancel"
				>Cancel resend</Button
			>
			<template v-if="result"
				><p>
					<strong>{{ result.status }}</strong> · {{ result.summary }}
				</p>
				<p v-if="result.outgoingMessageId">
					Last outgoing ID: <code>{{ result.outgoingMessageId }}</code> · source sequence
					{{ result.sourceSequenceNumber }}
				</p>
				<p v-if="result.copiedNotRemoved" class="inspector-warning">
					{{ result.copiedNotRemoved }} confirmed
					{{ result.copiedNotRemoved === 1 ? 'copy has' : 'copies have' }} no confirmed
					source removal. Review both namespaces before another resend.
				</p>
				<Button variant="outline" :disabled="savingReceipt" @click="saveReceipt(result)"
					>Save resend receipt</Button
				>
				<details
					v-if="result.crossNamespace && result.transfers.length"
					:open="needsReview(result)"
				>
					<summary>Per-message recovery receipt ({{ result.transfers.length }})</summary>
					<div class="recovery-receipts">
						<table>
							<thead>
								<tr>
									<th>Source sequence / original ID</th>
									<th>Outgoing ID</th>
									<th>Send</th>
									<th>Original</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="entry in result.transfers"
									:key="entry.sourceSequenceNumber"
								>
									<td>
										{{ entry.sourceSequenceNumber }}<br />{{
											entry.originalMessageId
										}}
									</td>
									<td>{{ entry.outgoingMessageId }}</td>
									<td>{{ entry.send }}</td>
									<td>{{ entry.source }}</td>
								</tr>
							</tbody>
						</table>
					</div>
				</details>
				<p v-if="result.cleanupWarning" class="inspector-warning">
					{{ result.cleanupWarning }}
				</p>
			</template>
			<template v-if="!running && sb.resendInterrupted"
				><p class="inspector-warning">
					The final result was not received. Confirmed counts are a lower bound; nothing
					will be retried automatically.
				</p>
				<Button variant="outline" :disabled="!!sb.busy" @click="sb.checkResendResult()"
					>Check resend result</Button
				></template
			>
			<p v-if="!running" class="explorer-note">
				Refresh counts and peek at source and destination to inspect the current state.
				Close this dialog to prepare a new, separately confirmed resend.
			</p>
		</section>
		<p v-if="receiptMessage" role="status">{{ receiptMessage }}</p>
		<p v-if="sb.error" class="form-error" role="alert">{{ sb.error }}</p>
	</div>
</template>

<style scoped>
.recovery-receipts {
	max-height: 18rem;
	overflow: auto;
}
.recovery-receipts table {
	width: 100%;
	font-size: 0.8rem;
	text-align: left;
}
.recovery-receipts td,
.recovery-receipts th {
	padding: 0.5rem;
	border-bottom: 1px solid var(--border);
	overflow-wrap: anywhere;
	max-width: 15rem;
}
</style>
