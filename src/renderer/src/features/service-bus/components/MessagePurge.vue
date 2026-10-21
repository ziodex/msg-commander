<script setup lang="ts">
import { serviceBusJob } from '@/features/service-bus/operation-progress'
import { subQueueLabel, type MessageSubQueue } from '@shared/service-bus'

import { computed, ref, watch } from 'vue'
import PurgeCutoff from './PurgeCutoff.vue'
import { emptyPurgeCutoff, selectedPurgeCutoff, describePurgeCutoff } from '@shared/purge-cutoff'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { purgeConfirmation, type PurgeResult } from '@shared/contracts/service-bus/maintenance'
import type { PeekTarget } from '@shared/service-bus'
const props = defineProps<{ target: PeekTarget; subQueue: MessageSubQueue }>()
const sb = useServiceBus()
const workspace = useWorkspace()
const acknowledged = ref(false),
	maxMessages = ref(10000),
	maxSeconds = ref(60)
const previousResult = ref<PurgeResult>()
const cutoffSelection = ref(emptyPurgeCutoff())
const cutoff = computed(() => selectedPurgeCutoff(cutoffSelection.value))
watch(
	[
		cutoffSelection,
		maxMessages,
		maxSeconds,
		() => props.target,
		() => props.subQueue,
		() => sb.connection?.connectionId,
	],
	() => {
		acknowledged.value = false
	},
	{ deep: true },
)
async function checkResult() {
	await sb.checkPurgeResult()
	if (!attempted.value) previousResult.value = sb.purgeResult
}
const attempted = ref(false),
	stopping = ref(false)
const phrase = computed(() =>
	purgeConfirmation(
		sb.connection?.namespace ?? '',
		props.target,
		props.subQueue,
		cutoff.value ?? undefined,
	),
)
const job = computed(() =>
	serviceBusJob(workspace.jobs.find((item) => item.id === sb.purgeOperationId)),
)
const running = computed(() => attempted.value && job.value?.status === 'running')
const result = computed(() => (attempted.value ? sb.purgeResult : undefined))
const valid = computed(
	() =>
		acknowledged.value &&
		cutoff.value !== null &&
		Number.isInteger(maxMessages.value) &&
		maxMessages.value >= 1 &&
		maxMessages.value <= 100000 &&
		Number.isInteger(maxSeconds.value) &&
		maxSeconds.value >= 1 &&
		maxSeconds.value <= 600,
)
async function start() {
	if (!valid.value || attempted.value) return
	attempted.value = true
	await sb.purgeMessages({
		target: { ...props.target },
		subQueue: props.subQueue,
		confirmation: phrase.value,
		maxMessages: maxMessages.value,
		maxSeconds: maxSeconds.value,
		...(cutoff.value ? { beforeEnqueueTime: cutoff.value } : {}),
	})
}
async function cancel() {
	stopping.value = true
	await workspace.cancel(sb.purgeOperationId)
}
</script>
<template>
	<div class="purge-manager">
		<p class="write-destination">
			{{ sb.connection?.namespace }}<br />{{ target.kind }} /
			{{ target.kind === 'subscription' ? target.topicName + ' / ' : '' }}{{ target.name }} ·
			<strong>{{
				subQueue === 'active' ? 'Main queue' : subQueueLabel(subQueue) + ' queue'
			}}</strong>
		</p>
		<p class="inspector-warning">
			Permanently delete available messages from this destination. Completed deletions cannot
			be undone. New arrivals may be included while the job runs.
		</p>
		<p class="explorer-note">
			Locked, deferred and scheduled messages may remain. Session state is preserved. An empty
			receive is not proof the entity is empty. Cancellation stops further work; a completion
			already in flight may still delete a message.
		</p>
		<template v-if="!attempted">
			<p v-if="sb.held.target" class="inspector-warning">
				Close the current message or session receiver before purging.
			</p>
			<p v-if="sb.bulkPurgeInterrupted || sb.bulkPurgeNeedsReview" class="inspector-warning">
				Review the previous bulk purge using the namespace's Bulk purge button before
				starting another purge.
			</p>
			<p v-if="sb.purgeInterrupted" class="inspector-warning">
				A previous purge was interrupted. Check its result before starting another.
			</p>
			<Button
				v-if="sb.purgeInterrupted"
				variant="outline"
				:disabled="!!sb.busy"
				@click="checkResult"
				>Check purge result</Button
			>
			<p v-if="previousResult" class="inspector-warning">
				Previous purge:
				{{
					previousResult.target.kind === 'subscription'
						? previousResult.target.topicName + ' / '
						: ''
				}}{{ previousResult.target.name }} / {{ previousResult.subQueue }} ·
				{{ previousResult.summary }}
			</p>
			<div class="explorer-actions">
				<label
					>Maximum deletions<Input
						v-model.number="maxMessages"
						aria-label="Maximum purge deletions"
						type="number"
						min="1"
						max="100000"
				/></label>
				<label
					>Time limit (seconds)<Input
						v-model.number="maxSeconds"
						aria-label="Purge time limit"
						type="number"
						min="1"
						max="600"
				/></label>
			</div>
			<PurgeCutoff v-model="cutoffSelection" />
			<label class="purge-ack"
				><input v-model="acknowledged" type="checkbox" />I understand these deletions are
				permanent and may include new arrivals.</label
			>
			<Button
				variant="destructive"
				:disabled="
					!valid ||
					!!sb.busy ||
					!!sb.held.target ||
					sb.purgeInterrupted ||
					sb.bulkPurgeInterrupted ||
					sb.bulkPurgeNeedsReview
				"
				@click="start"
				>Start purge</Button
			>
		</template>
		<section v-else aria-label="Purge result" aria-live="polite">
			<p v-if="running">
				{{
					stopping
						? 'Stopping purge… Waiting for the final broker result.'
						: 'Purge running…'
				}}
			</p>
			<p v-if="job?.purge || result" class="purge-count">
				<strong>{{ result?.completed ?? job?.purge?.completed ?? 0 }}</strong> deletions
				confirmed · {{ result?.received ?? job?.purge?.received ?? 0 }} received ·
				{{ result?.uncertain ?? job?.purge?.uncertain ?? 0 }} uncertain
				<template v-if="result?.beforeEnqueueTime || job?.purge?.beforeEnqueueTime">
					· {{ result?.skipped ?? job?.purge?.skipped ?? 0 }} retained by cutoff</template
				>
			</p>
			<p
				v-if="result?.beforeEnqueueTime || job?.purge?.beforeEnqueueTime"
				class="explorer-note"
			>
				Enqueued before
				{{
					describePurgeCutoff(
						(result?.beforeEnqueueTime ?? job?.purge?.beforeEnqueueTime)!,
					)
				}}
			</p>
			<p v-if="running && job?.purge" class="explorer-note">
				{{ job.purge.phase }} · {{ Math.round(job.purge.elapsedMs / 1000) }} seconds · limit
				{{ maxMessages }} deletions
			</p>
			<progress v-if="running" aria-label="Purge progress" />
			<Button v-if="running" variant="outline" :disabled="stopping" @click="cancel"
				>Cancel purge</Button
			>
			<template v-if="result"
				><p>
					<strong>{{ result.status }}</strong> · {{ result.summary }}
				</p>
				<p v-if="result.cleanupWarning" class="inspector-warning">
					{{ result.cleanupWarning }}
				</p></template
			>
			<template v-if="!running && sb.purgeInterrupted"
				><p class="inspector-warning">
					The final result was not received. Displayed confirmed deletions are only a
					lower bound. Nothing will be retried automatically.
				</p>
				<Button variant="outline" :disabled="!!sb.busy" @click="checkResult"
					>Check purge result</Button
				></template
			>
			<p v-if="!running" class="explorer-note">
				Refresh entity counts and peek again to inspect what remains. Close this dialog to
				prepare a new, separately confirmed purge.
			</p>
		</section>
		<p v-if="sb.error" class="inline-error" role="alert">{{ sb.error }}</p>
	</div>
</template>
