<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useBulkEntities } from '@/features/service-bus/stores/bulk-entities'
import { useListeners } from '@/features/service-bus/stores/listeners'
import { useWorkspace } from '@/shared/workspace/store'
import { bulkEntityKey, supportsBulkStatus, type BulkEntityAction } from '@shared/bulk-entities'
import { entityPath } from '@shared/entity-management'
const sb = useServiceBus(),
	tree = useEntityTree(),
	bulk = useBulkEntities(),
	listeners = useListeners(),
	workspace = useWorkspace()
defineProps<{ hideTrigger?: boolean }>()
const opened = ref(false),
	step = ref<'select' | 'review' | 'result'>('select'),
	choice = ref('Disabled'),
	maxSeconds = ref(120)
const requiresTyping = computed(
	() =>
		bulk.plan?.action.kind === 'delete' &&
		bulk.plan.items.some((item) => item.target.kind !== 'queue'),
)
const confirmation = ref(''),
	acknowledged = ref(false),
	stopping = ref(false)
const running = computed(() => bulk.job?.status === 'running')
const locked = computed(() => !!sb.busy || running.value)
const blocked = computed(
	() =>
		listeners.active ||
		!!sb.held.target ||
		sb.purgeInterrupted ||
		sb.bulkPurgeInterrupted ||
		bulk.unresolved,
)
const action = computed<BulkEntityAction>(() =>
	choice.value === 'delete'
		? { kind: 'delete' }
		: {
				kind: 'status',
				status: choice.value as 'Active' | 'Disabled' | 'SendDisabled' | 'ReceiveDisabled',
			},
)
const compatible = computed(
	() =>
		choice.value === 'delete' ||
		tree.selectedTargets.every((target) => supportsBulkStatus(target, choice.value)),
)
const progress = computed(() => bulk.job?.bulkEntities)
const rows = computed(
	() =>
		bulk.result?.items ??
		progress.value?.items ??
		bulk.plan?.items.map((item) => ({
			target: item.target,
			status: 'not-started',
			summary: '',
		})) ??
		[],
)
function open() {
	opened.value = true
	step.value = bulk.result || bulk.interrupted || running.value ? 'result' : 'select'
	confirmation.value = ''
	acknowledged.value = false
	stopping.value = false
}
function close(value: boolean) {
	if (!locked.value) opened.value = value
}
async function review() {
	confirmation.value = ''
	acknowledged.value = false
	if (
		!blocked.value &&
		compatible.value &&
		(await bulk.prepare(tree.selectedTargets, action.value, maxSeconds.value))
	)
		step.value = 'review'
}
async function execute() {
	if (
		!bulk.plan ||
		blocked.value ||
		locked.value ||
		!acknowledged.value ||
		(requiresTyping.value && confirmation.value !== bulk.plan.confirmation)
	)
		return
	step.value = 'result'
	stopping.value = false
	await bulk.execute(bulk.plan.confirmation)
}
function changeSelection() {
	bulk.plan = undefined
	confirmation.value = ''
	acknowledged.value = false
	step.value = 'select'
}
function prepareAnother() {
	bulk.startNew()
	confirmation.value = ''
	acknowledged.value = false
	step.value = 'select'
}
async function cancel() {
	stopping.value = true
	await workspace.cancel(bulk.operationId)
}
function returnToTree() {
	tree.selectionMode = true
	opened.value = false
}
watch(
	() => sb.connection?.connectionId,
	() => {
		opened.value = false
		step.value = 'select'
	},
)
defineExpose({ open })
</script>
<template>
	<Button v-if="!hideTrigger" variant="outline" size="sm" :disabled="!!sb.busy" @click="open"
		>Bulk entities…</Button
	>
	<Dialog :open="opened" @update:open="close">
		<DialogContent
			class="message-dialog bulk-purge-dialog"
			:show-close-button="!locked"
			@escape-key-down="locked && $event.preventDefault()"
			@interact-outside="locked && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Bulk entity actions</DialogTitle
				><DialogDescription
					>Review the selected entities and their affected subscriptions before applying
					changes.</DialogDescription
				></DialogHeader
			>
			<div class="bulk-purge-manager">
				<p class="write-destination">{{ sb.connection?.namespace }}</p>
				<p v-if="listeners.active || sb.held.target" class="inspector-warning">
					Stop the listener and close the message/session receiver before changing
					entities.
				</p>
				<p v-if="sb.purgeInterrupted || sb.bulkPurgeInterrupted" class="inspector-warning">
					Check the interrupted purge receipt before changing entities.
				</p>
				<template v-if="step === 'select'">
					<p class="explorer-note">
						Select up to 100 entities in the tree. Folder and group selections include
						every page, regardless of filters. Topic deletion includes all its
						subscriptions, rules and stored messages.
					</p>
					<div class="explorer-actions">
						<Button variant="outline" :disabled="locked" @click="returnToTree"
							>Select in tree</Button
						><strong>{{ tree.selectedTargets.length }} entities selected</strong>
					</div>
					<ul class="bulk-entity-selection">
						<li v-for="target in tree.selectedTargets" :key="bulkEntityKey(target)">
							<span>{{ target.kind }} · {{ entityPath(target) }}</span
							><Button
								variant="ghost"
								size="sm"
								:aria-label="`Remove ${target.kind} ${entityPath(target)} from selection`"
								:disabled="locked"
								@click="tree.toggleChecked(target)"
								>Remove</Button
							>
						</li>
					</ul>
					<label
						>Action<select
							v-model="choice"
							aria-label="Bulk entity action"
							:disabled="locked"
						>
							<option value="Active">Enable (Active)</option>
							<option value="Disabled">Disable</option>
							<option
								value="SendDisabled"
								:disabled="
									!tree.selectedTargets.every((target) =>
										supportsBulkStatus(target, 'SendDisabled'),
									)
								"
							>
								Disable sending
							</option>
							<option
								value="ReceiveDisabled"
								:disabled="
									!tree.selectedTargets.every((target) =>
										supportsBulkStatus(target, 'ReceiveDisabled'),
									)
								"
							>
								Disable receiving
							</option>
							<option value="delete">Delete entities permanently</option>
						</select></label
					>
					<p v-if="!compatible" role="alert" class="inline-error">
						This status is not supported by every selected entity. Choose another
						action.
					</p>
					<p v-if="choice !== 'delete'" class="explorer-note">
						Only the status changes. Subscription statuses are independent of their
						parent topic; select them explicitly to change them too.
					</p>
					<label
						>Whole-job time limit (seconds)<Input
							v-model.number="maxSeconds"
							aria-label="Bulk entity time limit"
							type="number"
							min="1"
							max="600"
							:disabled="locked"
					/></label>
					<Button
						:disabled="
							locked ||
							blocked ||
							tree.selectionBusy ||
							!tree.selectedTargets.length ||
							!compatible ||
							!Number.isInteger(maxSeconds) ||
							maxSeconds < 1 ||
							maxSeconds > 600
						"
						@click="review"
						>Review entity actions</Button
					>
					<template v-if="sb.busy === 'Review bulk entity actions'"
						><p role="status">Preparing review… No entities are being changed.</p>
						<Button
							variant="outline"
							@click="
								workspace.cancel(
									workspace.jobs.find(
										(job) =>
											job.label === 'Review bulk entity actions' &&
											job.status === 'running',
									)?.id ?? '',
								)
							"
							>Cancel review</Button
						></template
					>
				</template>
				<template v-if="step === 'review' && bulk.plan">
					<p
						:class="
							bulk.plan.action.kind === 'delete'
								? 'inspector-warning'
								: 'explorer-note'
						"
					>
						{{
							bulk.plan.action.kind === 'delete'
								? 'Permanently delete'
								: `Set status to ${bulk.plan.action.status} for`
						}}
						{{ bulk.plan.affectedCount }} entities with
						{{ bulk.plan.items.length }} broker action{{
							bulk.plan.items.length === 1 ? '' : 's'
						}}. Cancellation stops remaining work; completed changes cannot be undone.
					</p>
					<div class="bulk-target-picker">
						<table class="bulk-purge-table">
							<thead>
								<tr>
									<th>Entity</th>
									<th>Current status</th>
									<th>Change / affected subscriptions</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="item in bulk.plan.items"
									:key="bulkEntityKey(item.target)"
								>
									<th>
										{{ entityPath(item.target)
										}}<small>{{ item.target.kind }}</small>
									</th>
									<td>{{ item.currentStatus }}</td>
									<td v-if="bulk.plan.action.kind === 'status'">
										{{ bulk.plan.action.status
										}}{{
											item.currentStatus === bulk.plan.action.status
												? ' (already set)'
												: ''
										}}
									</td>
									<td v-else>
										Delete entity<small v-if="item.target.kind === 'topic'"
											>{{ item.subscriptions.length }} subscriptions deleted
											with this topic:</small
										>
										<ul>
											<li
												v-for="child in item.subscriptions"
												:key="bulkEntityKey(child)"
											>
												{{ entityPath(child) }}
											</li>
										</ul>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p class="explorer-note">
						Review expires in 10 minutes. Time limit:
						{{ bulk.plan.maxSeconds }} seconds. Settings and subscription lists are
						checked again before applying changes. Concurrent Azure changes can still
						race these checks; stop other administration while this job runs.
					</p>
					<label v-if="requiresTyping"
						>Type this exact confirmation:<code class="purge-phrase">{{
							bulk.plan.confirmation
						}}</code
						><Input
							v-model="confirmation"
							aria-label="Bulk entity confirmation"
							autocomplete="off"
					/></label>
					<label class="purge-ack"
						><input v-model="acknowledged" type="checkbox" />I reviewed every affected
						entity and understand the impact of this action.</label
					>
					<div class="explorer-actions">
						<Button variant="outline" :disabled="locked" @click="changeSelection"
							>Change selection or action</Button
						><Button
							:variant="
								bulk.plan.action.kind === 'delete' ? 'destructive' : 'default'
							"
							:disabled="
								locked ||
								blocked ||
								!acknowledged ||
								(requiresTyping && confirmation !== bulk.plan.confirmation)
							"
							@click="execute"
							>Apply entity actions</Button
						>
					</div>
				</template>
				<section
					v-if="step === 'result'"
					aria-label="Bulk entity result"
					class="bulk-purge-manager"
				>
					<p v-if="running" role="status">
						{{
							stopping
								? 'Stopping… Waiting for the broker result.'
								: 'Applying bulk entity actions…'
						}}
					</p>
					<p class="purge-count" aria-live="polite">
						<strong>{{ bulk.result?.confirmed ?? progress?.confirmed ?? 0 }}</strong>
						change{{
							(bulk.result?.confirmed ?? progress?.confirmed ?? 0) === 1 ? '' : 's'
						}}
						confirmed ·
						{{ bulk.result?.uncertain ?? progress?.uncertain ?? 0 }} uncertain
					</p>
					<p v-if="running && progress?.activeIndex != null">
						{{ progress.phase }}:
						{{ entityPath(progress.items[progress.activeIndex]!.target) }}
					</p>
					<progress v-if="running" aria-label="Bulk entity progress" />
					<Button v-if="running" variant="outline" :disabled="stopping" @click="cancel"
						>Cancel entity actions</Button
					>
					<div class="bulk-target-picker">
						<table class="bulk-purge-table">
							<thead>
								<tr>
									<th>Entity</th>
									<th>Result</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="(row, index) in rows" :key="bulkEntityKey(row.target)">
									<th>
										{{ entityPath(row.target)
										}}<small>{{ row.target.kind }}</small>
									</th>
									<td>
										{{
											!bulk.result &&
											bulk.interrupted &&
											row.status === 'not-started'
												? 'outcome unconfirmed'
												: running && progress?.activeIndex === index
													? progress.phase
													: row.status
										}}<small>{{ row.summary }}</small>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-if="bulk.result" role="status">
						<strong>{{ bulk.result.status }}</strong> · {{ bulk.result.summary }}
					</p>
					<template v-if="bulk.interrupted"
						><p class="inspector-warning">
							The final result was not received. More changes may have completed than
							shown. Nothing will be retried automatically.
						</p>
						<Button variant="outline" :disabled="locked" @click="bulk.check"
							>Check entity action result</Button
						></template
					>
					<label v-if="bulk.result?.status === 'unknown' && !running" class="purge-ack"
						><input
							type="checkbox"
							:checked="!bulk.needsReview"
							@change="
								bulk.needsReview = !($event.target as HTMLInputElement).checked
							"
						/>I inspected the affected entities and reviewed the uncertain outcome
						before preparing another action.</label
					>
					<Button
						v-if="!running"
						variant="outline"
						:disabled="locked || blocked"
						@click="prepareAnother"
						>Prepare another entity action</Button
					>
				</section>
				<p v-if="bulk.error" role="alert" class="inline-error">{{ bulk.error }}</p>
			</div>
		</DialogContent>
	</Dialog>
</template>
