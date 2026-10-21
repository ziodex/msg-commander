<script setup lang="ts">
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import { eventGridJob } from '@/features/event-grid/operation-progress'
import { eventGridApi } from '@/features/event-grid/api'

import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
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
import { useEventGrid } from '@/features/event-grid/stores/event-grid'
import { useWorkspace } from '@/shared/workspace/store'
import { eventGridPath, type EventGridTarget } from '@shared/contracts/event-grid/core'
import {
	eventGridReceiveSchema,
	eventGridSettleSchema,
	type EventGridSettle,
	type EventGridReceived,
} from '@shared/contracts/event-grid/pulling'
import JsonBody from '../../../shared/components/JsonBody.vue'
import { prettyJson } from '@/shared/lib/message-body'
const props = defineProps<{ target: EventGridTarget }>(),
	emit = defineEmits<{ close: [] }>(),
	grid = useEventGrid(),
	workspace = useWorkspace()
const maxEvents = ref(10),
	batchSize = ref(5),
	maxWaitSeconds = ref(10),
	maxSeconds = ref(60),
	confirmedReceive = ref(false),
	confirmedSettle = ref(false),
	selected = ref<string[]>([]),
	action = ref<EventGridSettle['action']>('acknowledge'),
	delay = ref(0),
	error = ref(''),
	now = ref(Date.now())
watch([maxEvents, batchSize, maxWaitSeconds, maxSeconds], () => {
	confirmedReceive.value = false
})
watch(
	[selected, action, delay],
	() => {
		confirmedSettle.value = false
	},
	{ deep: true },
)
const operationStarted = ref(Date.now())
watch(
	() => grid.operationId,
	() => {
		operationStarted.value = Date.now()
	},
)
let timer: ReturnType<typeof setInterval>
onMounted(() => {
	void grid.refreshReceived(props.target)
	timer = setInterval(() => {
		now.value = Date.now()
	}, 1000)
})
onBeforeUnmount(() => {
	clearInterval(timer)
	grid.eventInspection = undefined
})
const items = computed(() => grid.received[eventGridPath(props.target)] ?? []),
	job = computed(() => eventGridJob(workspace.jobs.find((j) => j.id === grid.operationId))),
	outcome = computed(() =>
		grid.pullOutcome && eventGridPath(grid.pullOutcome.target) === eventGridPath(props.target)
			? grid.pullOutcome
			: undefined,
	)
const held = (item: EventGridReceived) =>
	item.state === 'held' && Date.parse(item.estimatedLockedUntil) > now.value
const remaining = (item: EventGridReceived) =>
	Math.max(0, Math.floor((Date.parse(item.estimatedLockedUntil) - now.value) / 1000))
const eligible = computed(() => items.value.filter(held)),
	checked = computed(() =>
		selected.value.filter((h) => eligible.value.some((i) => i.handle === h)),
	)
const inspection = computed(() =>
	grid.eventInspection &&
	eventGridPath(grid.eventInspection.item.target) === eventGridPath(props.target)
		? grid.eventInspection
		: undefined,
)
const message = computed(() =>
	action.value === 'acknowledge'
		? 'Acknowledge removes the selected events from this subscription. Other subscriptions are unaffected.'
		: action.value === 'release'
			? 'Release makes the selected events available to consumers after the chosen delay.'
			: action.value === 'reject'
				? 'Reject removes the selected events from this subscription. Azure dead-letters them if a destination exists; otherwise it drops them.'
				: 'Renew extends the selected locks by the subscription’s configured duration. Renewal requests must be within one hour of the original receive.',
)
async function receive() {
	error.value = ''
	const p = eventGridReceiveSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: grid.connection?.connectionId,
		target: props.target,
		maxEvents: maxEvents.value,
		batchSize: batchSize.value,
		maxWaitSeconds: maxWaitSeconds.value,
		maxSeconds: maxSeconds.value,
		acknowledged: confirmedReceive.value,
	})
	if (!p.success) {
		error.value =
			'Confirm receiving and choose 1–100 events, 1–10 per request, a 10–120 second wait and a 1–300 second job limit.'
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = p.data
	await grid.receive(setup)
	confirmedReceive.value = false
	selected.value = []
}
async function settle() {
	error.value = ''
	const p = eventGridSettleSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: grid.connection?.connectionId,
		target: props.target,
		action: action.value,
		handles: checked.value,
		releaseDelaySeconds: action.value === 'release' ? delay.value : 0,
		acknowledged: confirmedSettle.value,
	})
	if (!p.success) {
		error.value = 'Select held events and confirm the settlement action.'
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = p.data
	await grid.settle(setup)
	confirmedSettle.value = false
	selected.value = []
}
async function signIn() {
	const value = await eventGridApi.openDeviceLogin()
	if (!value.ok) error.value = value.error.message
}
function selectInspection() {
	if (!inspection.value) return
	selected.value = [inspection.value.item.handle]
	grid.eventInspection = undefined
}
function close() {
	if (!grid.blocked) emit('close')
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && close()"
		><DialogContent
			class="eg-receiver sm:max-w-[1100px]"
			:show-close-button="false"
			@escape-key-down="grid.blocked && $event.preventDefault()"
			@interact-outside="grid.blocked && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Receive Event Grid events</DialogTitle
				><DialogDescription
					>{{ eventGridPath(target) }} ·
					{{ grid.connection?.namespace }}</DialogDescription
				></DialogHeader
			>
			<LoadingIndicator v-if="grid.busy" :label="`${grid.busy}…`" :announce="false" />
			<div class="eg-receiver-scroll" :aria-busy="!!grid.busy">
				<p class="field-hint">
					Receive locks events for this consumer. This competes with other consumers; it
					is not a peek. Closing this window keeps local snapshots. Disconnecting drops
					local handles and lets Azure locks expire. Nothing is automatically acknowledged
					or renewed.
				</p>
				<form class="eg-receive-form" @submit.prevent="receive">
					<div class="eg-receive-fields">
						<label
							>Maximum events<Input
								v-model.number="maxEvents"
								type="number"
								min="1"
								max="100"
								:disabled="grid.blocked"
						/></label>
						<label
							>Events per request<Input
								v-model.number="batchSize"
								type="number"
								min="1"
								max="10"
								:disabled="grid.blocked"
						/></label>
						<label
							>Request wait (seconds)<Input
								v-model.number="maxWaitSeconds"
								type="number"
								min="10"
								max="120"
								:disabled="grid.blocked"
						/></label>
						<label
							>Receive time limit (seconds)<Input
								v-model.number="maxSeconds"
								type="number"
								min="1"
								max="300"
								:disabled="grid.blocked"
						/></label>
					</div>
					<label class="eg-check"
						><input
							v-model="confirmedReceive"
							type="checkbox"
							:disabled="grid.blocked"
						/>
						I understand receiving locks events from this subscription.</label
					><Button type="submit" :disabled="grid.writeBlocked || !confirmedReceive"
						>Receive events</Button
					>
				</form>
				<div class="nh-actions">
					<strong
						>{{ items.length }} retained · {{ eligible.length }} held with an unexpired
						estimate</strong
					><Button
						size="sm"
						variant="outline"
						:disabled="grid.blocked"
						@click="grid.refreshReceived(target)"
						>Refresh received events</Button
					><Button
						size="sm"
						variant="ghost"
						:disabled="grid.blocked"
						@click="grid.refreshReceived(target, true)"
						>Clear finished snapshots</Button
					>
				</div>
				<p class="field-hint">
					At most 100 snapshots per connection. Clear removes only local finished
					snapshots. Lock times are conservative estimates, not service timestamps; Azure
					may expire a lock earlier.
				</p>
				<div class="eg-event-table">
					<table aria-label="Received Event Grid events">
						<thead>
							<tr>
								<th>
									<input
										type="checkbox"
										aria-label="Select all held events"
										:checked="
											!!eligible.length && checked.length === eligible.length
										"
										:disabled="grid.blocked || !eligible.length"
										@change="
											selected = ($event.target as HTMLInputElement).checked
												? eligible.map((i) => i.handle)
												: []
										"
									/>
								</th>
								<th>Event ID / type</th>
								<th>Source</th>
								<th>Delivery</th>
								<th>Status / estimated lock</th>
								<th>Inspect</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="item in items" :key="item.handle">
								<td>
									<input
										v-model="selected"
										type="checkbox"
										:value="item.handle"
										:aria-label="`Select event ${item.eventId}`"
										:disabled="grid.blocked || !held(item)"
									/>
								</td>
								<td>
									{{ item.eventId }}<small>{{ item.eventType }}</small>
								</td>
								<td>{{ item.source }}</td>
								<td>{{ item.deliveryCount }}</td>
								<td>
									{{
										item.state === 'held' && !held(item)
											? 'estimated expired'
											: item.state
									}}<small v-if="held(item)"
										>~{{ remaining(item) }}s remaining</small
									>
								</td>
								<td>
									<Button
										size="sm"
										variant="outline"
										:disabled="grid.blocked"
										:aria-label="`Inspect event ${item.eventId}`"
										@click="grid.inspectEvent(target, item.handle)"
										>Inspect</Button
									>
								</td>
							</tr>
							<tr v-if="!items.length">
								<td colspan="6">No events retained for this subscription.</td>
							</tr>
						</tbody>
					</table>
				</div>
				<section class="eg-settle" aria-label="Event Grid settlement">
					<h3>Settle selected events · {{ checked.length }}</h3>
					<div class="eg-receive-fields">
						<label
							>Settlement action<select
								aria-label="Settlement action"
								v-model="action"
								:disabled="grid.blocked"
								@change="confirmedSettle = false"
							>
								<option value="acknowledge">Acknowledge</option>
								<option value="release">Release</option>
								<option value="reject">Reject</option>
								<option value="renewLock">Renew lock</option>
							</select></label
						><label v-if="action === 'release'"
							>Release delay<select
								aria-label="Release delay"
								v-model.number="delay"
								:disabled="grid.blocked"
							>
								<option :value="0">Immediately</option>
								<option :value="10">10 seconds</option>
								<option :value="60">1 minute</option>
								<option :value="600">10 minutes</option>
								<option :value="3600">1 hour</option>
							</select></label
						>
					</div>
					<p
						:class="
							action === 'reject' || action === 'acknowledge'
								? 'form-warning'
								: 'field-hint'
						"
					>
						{{ message }}
					</p>
					<label class="eg-check"
						><input
							v-model="confirmedSettle"
							type="checkbox"
							:disabled="grid.blocked"
						/>
						I confirm this settlement action for the selected events.</label
					><Button
						:variant="action === 'reject' ? 'destructive' : 'default'"
						:disabled="grid.writeBlocked || !confirmedSettle || !checked.length"
						@click="settle"
						>Apply settlement</Button
					>
				</section>
				<section
					v-if="outcome"
					class="eg-admin-receipt"
					aria-label="Event Grid pull receipt"
				>
					<strong>{{ outcome.action }} · {{ outcome.status }}</strong>
					<p>{{ outcome.summary }}</p>
					<p class="field-hint">Receipt: {{ outcome.operationId }}</p>
					<ul v-if="outcome.results.length">
						<li v-for="result in outcome.results" :key="result.handle">
							{{
								items.find((i) => i.handle === result.handle)?.eventId ??
								result.handle
							}}
							· {{ result.status
							}}{{ result.errorCode ? ' · ' + result.errorCode : '' }}
						</li>
					</ul>
					<Button variant="outline" :disabled="grid.blocked" @click="grid.recoverPull()"
						>Recover pull receipt</Button
					><label v-if="outcome.status === 'unknown'" class="eg-check"
						><input
							v-model="grid.pullReviewed"
							type="checkbox"
							:disabled="grid.blocked"
						/>
						I reviewed the uncertain outcome and retained events before another
						operation.</label
					>
				</section>
			</div>
			<section v-if="grid.busy" class="eg-pull-progress" role="status">
				<p>{{ grid.busy }}…</p>
				<p v-if="job?.eventGridPull">
					{{ job.eventGridPull.confirmed }}/{{ job.eventGridPull.requested }} confirmed ·
					{{ job.eventGridPull.failed }} failed ·
					{{ job.eventGridPull.uncertain }} uncertain · {{ job.eventGridPull.phase }} ·
					{{ Math.floor((now - operationStarted) / 1000) }}s
				</p>
				<progress
					v-if="job?.eventGridPull"
					:value="job.eventGridPull.confirmed"
					:max="job.eventGridPull.requested"
				/><template v-if="job?.code"
					><p>Sign in to continue.</p>
					<p class="device-code">{{ job.code }}</p>
					<Button variant="outline" @click="signIn"
						>Open Microsoft sign-in</Button
					></template
				>
			</section>
			<p v-if="error || grid.error" class="form-error" role="alert">
				{{ error || grid.error }}
			</p>
			<DialogFooter
				><Button v-if="grid.busy" variant="outline" @click="grid.cancel()"
					>Cancel pull operation</Button
				><Button variant="outline" :disabled="grid.blocked" @click="close"
					>Close receiver</Button
				></DialogFooter
			>
		</DialogContent></Dialog
	>
	<Dialog
		:open="!!inspection"
		@update:open="!$event && !grid.blocked && (grid.eventInspection = undefined)"
		><DialogContent
			class="eg-event-inspector sm:max-w-[920px]"
			:show-close-button="false"
			@escape-key-down="grid.blocked && $event.preventDefault()"
			@interact-outside="grid.blocked && $event.preventDefault()"
			><DialogHeader
				><DialogTitle>Event Grid event inspection</DialogTitle
				><DialogDescription
					>{{ inspection?.item.eventId }} ·
					{{ inspection?.item.state }}</DialogDescription
				></DialogHeader
			>
			<div v-if="inspection" class="eg-receiver-scroll">
				<p class="field-hint">
					{{ inspection.item.bytes }} bytes · Delivery
					{{ inspection.item.deliveryCount }} · Estimated lock until
					{{ new Date(inspection.item.estimatedLockedUntil).toLocaleString() }}
				</p>
				<p v-if="inspection.truncated" class="form-warning">
					Preview truncated at 65,536 characters. The full event is retained in the
					backend. Settlement applies to the full event.
				</p>
				<pre v-if="inspection.truncated" class="body-preview">{{
					inspection.eventJson
				}}</pre>
				<JsonBody v-else :text="prettyJson(inspection.eventJson) ?? inspection.eventJson" />
				<p class="field-hint">
					To settle this event, select it and choose an action in the receiver.
				</p>
			</div>
			<DialogFooter
				><Button
					:disabled="grid.blocked || !inspection || !held(inspection.item)"
					@click="selectInspection"
					>Select this event for settlement</Button
				><Button
					variant="outline"
					:disabled="grid.blocked"
					@click="grid.eventInspection = undefined"
					>Close event inspection</Button
				></DialogFooter
			></DialogContent
		></Dialog
	>
</template>
<style>
.eg-receiver,
.eg-event-inspector {
	display: flex;
	flex-direction: column;
	max-height: 92vh;
	gap: 16px;
	min-height: 0;
}
.eg-receiver-scroll {
	overflow: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 16px;
}
.eg-receiver-scroll > * {
	flex-shrink: 0;
}
.eg-receive-form,
.eg-settle {
	display: flex;
	flex-direction: column;
	gap: 12px;
	border: 1px solid var(--border);
	padding: 16px;
	border-radius: 8px;
}
.eg-receive-form > button,
.eg-settle > button {
	align-self: flex-start;
}
.eg-receive-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
	gap: 12px;
}
.eg-receive-fields label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.eg-receive-fields select {
	border: 1px solid var(--border);
	border-radius: 6px;
	padding: 8px;
	background: var(--background);
}
.eg-event-table {
	overflow: auto;
	max-height: 350px;
	border: 1px solid var(--border);
	border-radius: 8px;
}
.eg-event-table table {
	width: 100%;
	font-size: 12px;
	text-align: left;
}
.eg-event-table th,
.eg-event-table td {
	padding: 10px;
	border-bottom: 1px solid var(--border);
	max-width: 250px;
	overflow-wrap: anywhere;
}
.eg-event-table th {
	background: var(--muted);
	position: sticky;
	top: 0;
}
.eg-event-table small {
	display: block;
	color: var(--muted-foreground);
}
.eg-pull-progress {
	border-top: 1px solid var(--border);
	padding-top: 10px;
	font-size: 12px;
}
.eg-pull-progress progress {
	width: 100%;
}
.eg-event-inspector .body-preview {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: none;
}
.eg-receiver .eg-admin-receipt ul {
	max-height: 160px;
	overflow: auto;
	font-size: 12px;
}
</style>
