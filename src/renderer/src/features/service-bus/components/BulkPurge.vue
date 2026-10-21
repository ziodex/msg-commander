<script setup lang="ts">
import { serviceBusJob } from '@/features/service-bus/operation-progress'
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
import { useWorkspace } from '@/shared/workspace/store'
import { useListeners } from '@/features/service-bus/stores/listeners'
import PurgeCutoff from './PurgeCutoff.vue'
import { emptyPurgeCutoff, selectedPurgeCutoff, describePurgeCutoff } from '@shared/purge-cutoff'
import {
	bulkPurgeKey,
	bulkPurgePreviewRequestSchema,
	type BulkPurgeTarget,
} from '@shared/contracts/service-bus/maintenance'
import { subQueueLabel, type PeekTarget, type MessageSubQueue } from '@shared/service-bus'
const sb = useServiceBus(),
	tree = useEntityTree(),
	workspace = useWorkspace(),
	listeners = useListeners()
defineProps<{ hideTrigger?: boolean }>()
const opened = ref(false),
	step = ref<'select' | 'review' | 'result'>('select')
const selected = ref<BulkPurgeTarget[]>([]),
	filter = ref(''),
	localError = ref('')
const maxPerTarget = ref(10000),
	maxTotal = ref(10000),
	maxSeconds = ref(60)
const cutoffSelection = ref(emptyPurgeCutoff())
const cutoff = computed(() => selectedPurgeCutoff(cutoffSelection.value))
const acknowledged = ref(false),
	stopping = ref(false)
const subqueues: MessageSubQueue[] = ['active', 'dead-letter', 'transfer-dead-letter']
const job = computed(() =>
	serviceBusJob(workspace.jobs.find((item) => item.id === sb.bulkPurgeOperationId)),
)
const running = computed(() => job.value?.status === 'running')
const locked = computed(() => !!sb.busy || running.value)
const blocked = computed(
	() =>
		!!sb.held.target ||
		listeners.active ||
		sb.purgeInterrupted ||
		sb.bulkPurgeInterrupted ||
		sb.bulkPurgeNeedsReview,
)
const plan = computed(() => sb.bulkPurgeResult?.plan ?? sb.bulkPurgePlan)
const progress = computed(() => job.value?.bulkPurge)
const rows = computed(
	() =>
		sb.bulkPurgeResult?.items ??
		progress.value?.items ??
		plan.value?.items.map((item) => ({ ...item, result: null })) ??
		[],
)
const path = (target: PeekTarget) =>
	target.kind === 'queue' ? target.name : `${target.topicName}/Subscriptions/${target.name}`
const candidates = computed(() =>
	Object.values(tree.branches)
		.flatMap((branch) => branch.items)
		.filter(
			(entity): entity is typeof entity & { target: PeekTarget } =>
				entity.target.kind !== 'topic',
		)
		.filter((entity) => path(entity.target).toLowerCase().includes(filter.value.toLowerCase())),
)
const targets = computed(() => [
	...new Map(
		candidates.value.map((entity) => [
			bulkPurgeKey({ target: entity.target, subQueue: 'active' }),
			entity.target,
		]),
	).values(),
])
function isSelected(target: PeekTarget, subQueue: MessageSubQueue) {
	return selected.value.some((item) => bulkPurgeKey(item) === bulkPurgeKey({ target, subQueue }))
}
function toggle(target: PeekTarget, subQueue: MessageSubQueue) {
	localError.value = ''
	const key = bulkPurgeKey({ target, subQueue })
	if (isSelected(target, subQueue))
		selected.value = selected.value.filter((item) => bulkPurgeKey(item) !== key)
	else if (selected.value.length < 100) selected.value.push({ target: { ...target }, subQueue })
	else localError.value = 'Select at most 100 entity/subqueue pairs per job.'
}
function selectVisible(subQueue: MessageSubQueue) {
	const values = new Map(selected.value.map((item) => [bulkPurgeKey(item), item]))
	for (const target of targets.value) {
		const item = { target: { ...target }, subQueue }
		values.set(bulkPurgeKey(item), item)
	}
	if (values.size > 100) {
		localError.value =
			'That selection exceeds 100 subqueues. Narrow the filter or select fewer targets.'
		return
	}
	selected.value = [...values.values()]
	localError.value = ''
}
async function open() {
	opened.value = true
	stopping.value = false
	if (sb.bulkPurgeResult || sb.bulkPurgeInterrupted || running.value) step.value = 'result'
	else step.value = 'select'
	if (!tree.branch('queue').loaded) await tree.load('queue')
	if (!tree.branch('topic').loaded) await tree.load('topic')
}
function close(value: boolean) {
	if (!locked.value) opened.value = value
}
const validSelection = computed(
	() =>
		!!sb.connection &&
		cutoff.value !== null &&
		bulkPurgePreviewRequestSchema.safeParse({
			id: sb.connection.connectionId,
			connectionId: sb.connection.connectionId,
			targets: selected.value,
			maxPerTarget: maxPerTarget.value,
			maxTotal: maxTotal.value,
			maxSeconds: maxSeconds.value,
			...(cutoff.value ? { beforeEnqueueTime: cutoff.value } : {}),
		}).success,
)
async function review() {
	if (!validSelection.value || blocked.value) return
	acknowledged.value = false
	if (
		await sb.previewBulkPurge({
			targets: selected.value.map((item) => ({
				target: { ...item.target },
				subQueue: item.subQueue,
			})),
			maxPerTarget: maxPerTarget.value,
			maxTotal: maxTotal.value,
			maxSeconds: maxSeconds.value,
			...(cutoff.value ? { beforeEnqueueTime: cutoff.value } : {}),
		})
	)
		step.value = 'review'
}
async function start() {
	if (!sb.bulkPurgePlan || !acknowledged.value || blocked.value || locked.value) return
	step.value = 'result'
	stopping.value = false
	await sb.bulkPurgeMessages(sb.bulkPurgePlan.confirmation)
}
async function cancel() {
	stopping.value = true
	await workspace.cancel(sb.bulkPurgeOperationId)
}
function changeSelection() {
	step.value = 'select'
	acknowledged.value = false
	sb.bulkPurgePlan = undefined
}
function prepare() {
	if (blocked.value || locked.value) return
	sb.bulkPurgeResult = undefined
	sb.bulkPurgePlan = undefined
	acknowledged.value = false
	step.value = 'select'
}
watch(
	() => sb.connection?.connectionId,
	() => {
		opened.value = false
		selected.value = []
		step.value = 'select'
		acknowledged.value = false
	},
)
watch(
	() => sb.bulkPurgePlan?.planId,
	() => {
		acknowledged.value = false
	},
)
defineExpose({ open })
</script>
<template>
	<Button v-if="!hideTrigger" variant="outline" size="sm" :disabled="!!sb.busy" @click="open"
		>Bulk purge…</Button
	>
	<Dialog :open="opened" @update:open="close">
		<DialogContent
			class="message-dialog bulk-purge-dialog"
			:show-close-button="!locked"
			@escape-key-down="locked && $event.preventDefault()"
			@interact-outside="locked && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Bulk purge messages</DialogTitle
				><DialogDescription>
					Select subqueues, review the exact list, then confirm permanent deletion.
				</DialogDescription></DialogHeader
			>
			<div class="bulk-purge-manager">
				<p class="write-destination">{{ sb.connection?.namespace }}</p>
				<p v-if="sb.held.target || listeners.active" class="inspector-warning">
					Close the message/session receiver and stop any listener before purging.
				</p>
				<p v-if="sb.purgeInterrupted" class="inspector-warning">
					Check the interrupted single-entity purge result before starting a bulk purge.
				</p>
				<template v-if="step === 'select'">
					<p class="explorer-note">
						Choose up to 100 subqueues. Nothing is selected by default. Selection stays
						when filtering or loading more entities. Topics are containers; only their
						selected subscriptions are purged.
					</p>
					<Input
						v-model="filter"
						aria-label="Filter bulk purge entities"
						placeholder="Filter loaded queues and subscriptions…"
					/>
					<div class="explorer-actions">
						<Button variant="outline" size="sm" @click="selectVisible('active')"
							>Select visible main queues</Button
						>
						<Button variant="outline" size="sm" @click="selectVisible('dead-letter')"
							>Select visible dead letters</Button
						>
						<Button variant="ghost" size="sm" @click="selected = []"
							>Clear selection</Button
						>
						<strong>{{ selected.length }} subqueues selected</strong>
					</div>
					<div class="bulk-target-picker">
						<table class="bulk-purge-table">
							<thead>
								<tr>
									<th>Loaded entity</th>
									<th v-for="subQueue in subqueues" :key="subQueue">
										{{ subQueueLabel(subQueue) }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="target in targets" :key="path(target) + target.kind">
									<th>
										{{ path(target) }}<small>{{ target.kind }}</small>
									</th>
									<td v-for="subQueue in subqueues" :key="subQueue">
										<input
											type="checkbox"
											:aria-label="`Select ${path(target)} / ${subQueueLabel(subQueue)}`"
											:checked="isSelected(target, subQueue)"
											:disabled="locked"
											@change="toggle(target, subQueue)"
										/>
									</td>
								</tr>
							</tbody>
						</table>
						<p v-if="!targets.length" class="explorer-note">
							No loaded entities match this filter.
						</p>
					</div>
					<div class="bulk-load-controls">
						<Button
							v-if="tree.branch('queue').continuationToken"
							variant="outline"
							size="sm"
							:disabled="tree.loading || locked"
							@click="tree.load('queue', undefined, true)"
							>Load more queues for purge</Button
						>
						<p v-if="tree.branch('queue').error" role="alert">
							{{ tree.branch('queue').error }}
						</p>
						<Button
							v-if="tree.branch('queue').error"
							variant="outline"
							size="sm"
							:disabled="tree.loading || locked"
							@click="tree.load('queue')"
							>Retry queues</Button
						>
						<div
							v-for="topic in tree.branch('topic').items"
							:key="topic.target.name"
							class="explorer-actions"
						>
							<span>{{ topic.target.name }}</span>
							<Button
								v-if="
									!tree.branch('subscription', topic.target.name).loaded ||
									tree.branch('subscription', topic.target.name)
										.continuationToken ||
									tree.branch('subscription', topic.target.name).error
								"
								variant="outline"
								size="sm"
								:disabled="tree.loading || locked"
								@click="
									tree.load(
										'subscription',
										topic.target.name,
										!!tree.branch('subscription', topic.target.name)
											.continuationToken,
									)
								"
							>
								Load subscriptions for {{ topic.target.name }} </Button
							><span v-else class="explorer-note">Subscriptions loaded</span>
							<p
								v-if="tree.branch('subscription', topic.target.name).error"
								role="alert"
							>
								{{ tree.branch('subscription', topic.target.name).error }}
							</p>
						</div>
						<Button
							v-if="
								tree.branch('topic').continuationToken || tree.branch('topic').error
							"
							variant="outline"
							size="sm"
							:disabled="tree.loading || locked"
							@click="
								tree.load(
									'topic',
									undefined,
									!!tree.branch('topic').continuationToken,
								)
							"
							>Load more topics for purge</Button
						>
						<p v-if="tree.branch('topic').error" role="alert">
							{{ tree.branch('topic').error }}
						</p>
					</div>
					<div class="bulk-purge-limits">
						<label
							>Deletions per subqueue<Input
								v-model.number="maxPerTarget"
								aria-label="Bulk purge per-target limit"
								type="number"
								min="1"
								max="100000"
						/></label>
						<label
							>Deletions across the whole job<Input
								v-model.number="maxTotal"
								aria-label="Bulk purge total limit"
								type="number"
								min="1"
								max="100000"
						/></label>
						<label
							>Whole-job time limit (seconds)<Input
								v-model.number="maxSeconds"
								aria-label="Bulk purge time limit"
								type="number"
								min="1"
								max="600"
						/></label>
					</div>
					<p v-if="localError" role="alert" class="inline-error">{{ localError }}</p>
					<PurgeCutoff v-model="cutoffSelection" />
					<Button
						:disabled="!validSelection || locked || blocked || tree.loading"
						@click="review"
						>Review selected targets</Button
					>
					<p v-if="sb.busy === 'Review bulk purge'" role="status">
						Preparing review… No messages are being deleted.
					</p>
					<Button
						v-if="sb.busy === 'Review bulk purge'"
						variant="outline"
						@click="
							workspace.cancel(
								workspace.jobs.find(
									(item) =>
										item.label === 'Review bulk purge' &&
										item.status === 'running',
								)?.id ?? '',
							)
						"
						>Cancel review</Button
					>
				</template>
				<template v-if="step === 'review' && sb.bulkPurgePlan">
					<p class="inspector-warning">
						Permanently delete available messages from these
						{{ sb.bulkPurgePlan.items.length }} subqueues, in this order. New arrivals
						may be included. Cancellation cannot undo a deletion already sent to the
						broker.
					</p>
					<div class="bulk-target-picker">
						<table class="bulk-purge-table">
							<thead>
								<tr>
									<th>Target</th>
									<th>Subqueue</th>
									<th>Count at review</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="item in sb.bulkPurgePlan.items"
									:key="bulkPurgeKey(item)"
								>
									<th>
										{{ path(item.target) }}<small>{{ item.target.kind }}</small>
									</th>
									<td>{{ subQueueLabel(item.subQueue) }}</td>
									<td>{{ item.estimatedCount ?? 'Unavailable' }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p>
						<strong>{{ sb.bulkPurgePlan.maxPerTarget }}</strong> deletions per subqueue
						· <strong>{{ sb.bulkPurgePlan.maxTotal }}</strong> overall ·
						<strong>{{ sb.bulkPurgePlan.maxSeconds }}</strong> seconds for the whole
						job.
					</p>
					<p class="explorer-note">
						Counts may lag and are not a deletion estimate. Locked, deferred and
						scheduled messages may remain; session state is preserved. The job stops at
						the first failed or uncertain target. This review expires in 10 minutes.
					</p>
					<p v-if="sb.bulkPurgePlan.beforeEnqueueTime" class="write-destination">
						Enqueued strictly before
						{{ describePurgeCutoff(sb.bulkPurgePlan.beforeEnqueueTime) }}. Counts above
						include all ages.
					</p>
					<p v-else class="explorer-note">All enqueue times; no age cutoff.</p>
					<label class="purge-ack"
						><input v-model="acknowledged" type="checkbox" />I reviewed every selected
						subqueue and understand these deletions are permanent.</label
					>
					<div class="explorer-actions">
						<Button variant="outline" :disabled="locked" @click="changeSelection"
							>Change selection</Button
						>
						<Button
							variant="destructive"
							:disabled="locked || blocked || !acknowledged"
							@click="start"
							>Start bulk purge</Button
						>
					</div>
				</template>
				<section
					v-if="step === 'result'"
					aria-label="Bulk purge result"
					class="bulk-purge-manager"
				>
					<p v-if="running" role="status">
						{{
							stopping
								? 'Stopping… Waiting for the final broker result.'
								: 'Bulk purge running…'
						}}
					</p>
					<p class="purge-count" aria-live="polite">
						<strong>{{
							sb.bulkPurgeResult?.completed ?? progress?.completed ?? 0
						}}</strong>
						deletions confirmed ·
						{{ sb.bulkPurgeResult?.received ?? progress?.received ?? 0 }} received ·
						{{ sb.bulkPurgeResult?.uncertain ?? progress?.uncertain ?? 0 }} uncertain
						<template v-if="plan?.beforeEnqueueTime">
							· {{ sb.bulkPurgeResult?.skipped ?? progress?.skipped ?? 0 }} retained
							by cutoff</template
						>
					</p>
					<p v-if="plan?.beforeEnqueueTime" class="explorer-note">
						Enqueued before {{ describePurgeCutoff(plan.beforeEnqueueTime) }}
					</p>
					<p v-if="plan" class="explorer-note">
						{{ rows.filter((item) => item.result).length }}/{{ plan.items.length }}
						targets attempted ·
						{{
							Math.round(
								(sb.bulkPurgeResult?.elapsedMs ?? progress?.elapsedMs ?? 0) / 1000,
							)
						}}
						seconds · overall limit {{ plan.maxTotal }} deletions
					</p>
					<p v-if="running && progress?.activeIndex != null">
						Current: {{ path(progress.items[progress.activeIndex]!.target) }} /
						{{ subQueueLabel(progress.items[progress.activeIndex]!.subQueue) }} ·
						{{ progress.current?.phase }}
					</p>
					<progress v-if="running" aria-label="Bulk purge progress" />
					<Button v-if="running" variant="outline" :disabled="stopping" @click="cancel"
						>Cancel bulk purge</Button
					>
					<div class="bulk-target-picker">
						<table class="bulk-purge-table">
							<thead>
								<tr>
									<th>Target / subqueue</th>
									<th>Result</th>
									<th>Deleted</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="(item, index) in rows" :key="bulkPurgeKey(item)">
									<th>
										{{ path(item.target)
										}}<small>{{ subQueueLabel(item.subQueue) }}</small>
									</th>
									<td>
										{{
											item.result?.status ??
											(sb.bulkPurgeInterrupted
												? 'outcome unconfirmed'
												: running && progress?.activeIndex === index
													? 'running'
													: 'not started')
										}}<small v-if="item.result">{{ item.result.summary }}</small
										><small v-if="item.result?.cleanupWarning">{{
											item.result.cleanupWarning
										}}</small>
									</td>
									<td>
										{{
											item.result?.completed ??
											(progress?.activeIndex === index
												? progress.current?.completed
												: 0) ??
											0
										}}
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-if="sb.bulkPurgeResult" role="status">
						<strong>{{ sb.bulkPurgeResult.status }}</strong> ·
						{{ sb.bulkPurgeResult.summary }}
					</p>
					<template v-if="!running && sb.bulkPurgeInterrupted"
						><p class="inspector-warning">
							The final result was not received. Confirmed progress is only a lower
							bound; additional deletions may have completed. Nothing will be retried
							automatically.
						</p>
						<Button
							variant="outline"
							:disabled="locked"
							@click="sb.checkBulkPurgeResult()"
							>Check bulk purge result</Button
						></template
					>
					<label
						v-if="!running && sb.bulkPurgeResult?.status === 'unknown'"
						class="purge-ack"
						><input
							type="checkbox"
							:checked="!sb.bulkPurgeNeedsReview"
							@change="
								sb.bulkPurgeNeedsReview = !($event.target as HTMLInputElement)
									.checked
							"
						/>I inspected the affected targets and reviewed the uncertain deletion
						before preparing another purge.</label
					>
					<p v-if="!running" class="explorer-note">
						Refresh counts and peek to inspect what remains. A completed read window
						does not guarantee an empty subqueue.
					</p>
					<Button
						v-if="!running"
						variant="outline"
						:disabled="locked || blocked"
						@click="prepare"
						>Prepare another bulk purge</Button
					>
				</section>
				<p v-if="sb.error" role="alert" class="inline-error">{{ sb.error }}</p>
			</div>
		</DialogContent>
	</Dialog>
</template>
