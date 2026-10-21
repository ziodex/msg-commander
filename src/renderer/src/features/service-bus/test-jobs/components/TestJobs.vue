<script setup lang="ts">
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { entityPath } from '@shared/entity-management'
import { useTestJob } from '../composables/useTestJob'
import TestJobStatistics from './TestJobStatistics.vue'
import TestPayloadEditor from './TestPayloadEditor.vue'

defineProps<{ hideTrigger?: boolean }>()
const {
	sb,
	visible,
	source,
	maxMessages,
	maxSeconds,
	delayMs,
	workers,
	batchSize,
	sessionId,
	body,
	contentType,
	acknowledged,
	generator,
	settlement,
	deadLetterReason,
	deadLetterDescription,
	settlementLabel,
	receiveWarning,
	acknowledgement,
	operationId,
	result,
	error,
	interrupted,
	reviewed,
	stopping,
	running,
	progress,
	confirmed,
	duration,
	rate,
	unresolved,
	blocked,
	valid,
	open,
	show,
	prepare,
	start,
	check,
	cancel,
	hasResult,
} = useTestJob()
defineExpose({ open, show, hasResult, running })
</script>
<template>
	<Button
		v-if="!hideTrigger"
		variant="outline"
		size="sm"
		:disabled="(!sb.selected && !operationId) || (!!sb.busy && !running)"
		@click="operationId ? (visible = true) : sb.selected && open(sb.selected.target)"
		>{{ operationId ? 'Test job result' : 'Test jobs…' }}</Button
	>
	<Dialog :open="visible" @update:open="!running && (visible = $event)">
		<DialogContent
			class="message-dialog test-job-dialog"
			:show-close-button="!running"
			@escape-key-down="running && $event.preventDefault()"
			@interact-outside="running && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Test job</DialogTitle
				><DialogDescription
					>Run a bounded send or receive test against the selected
					entity.</DialogDescription
				></DialogHeader
			>
			<template v-if="source">
				<p class="write-destination">
					{{ sb.connection?.namespace }}<br />{{ entityPath(source.target) }} ·
					{{
						source.mode === 'send'
							? 'Send messages'
							: `Receive & ${settlementLabel.toLowerCase()} · Messages`
					}}
				</p>
				<template v-if="!operationId">
					<label v-if="source.target.kind === 'queue'"
						>Job type<select v-model="source.mode" aria-label="Test job type">
							<option value="send">Send messages</option>
							<option value="receive">Receive &amp; complete</option>
						</select></label
					>
					<p class="explorer-note">
						Workers share the count and time limit. Delay applies between batches in
						each worker. Other namespace actions wait until this job finishes.
					</p>
					<label v-if="source.mode === 'receive'"
						>Settlement<select v-model="settlement" aria-label="Test settlement mode">
							<option value="complete">Complete</option>
							<option value="abandon">Abandon</option>
							<option value="defer">Defer</option>
							<option value="dead-letter">Dead-letter</option>
						</select></label
					>
					<p v-if="source.mode === 'receive'" class="inspector-warning">
						{{ receiveWarning }}
					</p>
					<p v-else class="explorer-note">
						Messages carry a job ID and unique index. Subscribers and forwarding
						destinations may receive them.
					</p>
					<p v-if="blocked" class="inspector-warning">
						Stop the listener and close the current message or session receiver first.
					</p>
					<div class="test-job-fields">
						<label
							>Workers<Input
								v-model.number="workers"
								aria-label="Test workers"
								type="number"
								min="1"
								max="8"
						/></label>
						<label
							>Batch size<Input
								v-model.number="batchSize"
								aria-label="Test batch size"
								type="number"
								min="1"
								max="100"
						/></label>
						<label
							>Message count<Input
								v-model.number="maxMessages"
								aria-label="Test message count"
								type="number"
								min="1"
								:max="
									source.mode === 'receive' && settlement === 'defer'
										? 1000
										: 100000
								"
						/></label>
						<label
							>Time limit (seconds)<Input
								v-model.number="maxSeconds"
								aria-label="Test time limit"
								type="number"
								min="1"
								max="600"
						/></label>
						<label
							>Batch delay (ms)<Input
								v-model.number="delayMs"
								aria-label="Test message delay"
								type="number"
								min="0"
								max="1000"
						/></label>
					</div>
					<label
						>Session ID (required for session-enabled entities)<Input
							v-model="sessionId"
							aria-label="Test session ID"
							maxlength="128"
					/></label>
					<p v-if="source.mode === 'receive' && sessionId" class="explorer-note">
						Selected sessions use one receive worker.
					</p>
					<TestPayloadEditor
						v-if="source.mode === 'send'"
						v-model:generator="generator"
						v-model:body="body"
						v-model:content-type="contentType"
					/>
					<template v-if="source.mode === 'receive' && settlement === 'dead-letter'">
						<label
							>Reason<Input
								v-model="deadLetterReason"
								aria-label="Test dead-letter reason"
								maxlength="128"
						/></label>
						<label
							>Description<Input
								v-model="deadLetterDescription"
								aria-label="Test dead-letter description"
								maxlength="1024"
						/></label>
					</template>
					<label class="confirm-check"
						><input v-model="acknowledged" type="checkbox" />{{
							acknowledgement
						}}</label
					>
					<p v-if="!valid && acknowledged" role="alert" class="error-banner">
						Use 1–8 workers, batch size 1–100, 1–100,000 messages, 1–600 seconds and
						0–1,000 ms delay. Selected-session receives require one worker. Defer is
						limited to 1,000 messages; dead-letter requires a reason.
					</p>
					<Button
						:variant="source.mode === 'receive' ? 'destructive' : 'default'"
						:disabled="!valid || !!sb.busy || blocked"
						@click="start"
						>Start test job</Button
					>
				</template>
				<section v-if="operationId" aria-label="Test job progress">
					<div class="test-job-metrics">
						<strong
							>{{ confirmed }} /
							{{ result?.maxMessages ?? maxMessages }} confirmed</strong
						><span>{{ (duration / 1000).toFixed(1) }} s elapsed</span
						><span>{{ rate }} /s average</span>
					</div>
					<p class="explorer-note">
						{{ result?.workers ?? workers }} workers · batch size
						{{ result?.batchSize ?? batchSize }}
						<span v-if="source.mode === 'send'">
							· {{ result?.sendBatches ?? progress?.sendBatches ?? 0 }} batches
							confirmed</span
						>
					</p>
					<progress
						:value="confirmed"
						:max="result?.maxMessages ?? maxMessages"
						aria-label="Test job message progress"
					/>
					<p class="explorer-note">
						Average counts acknowledged
						{{ source.mode === 'send' ? 'sends' : 'settlements' }} over total job time,
						including setup, idle time, pacing and cleanup.
					</p>
					<div v-if="running" role="status">
						<p>
							{{ progress?.phase ?? 'starting' }} ·
							{{ progress?.activeWorkers ?? 0 }} active workers<span
								v-if="source.mode === 'receive'"
							>
								· {{ progress?.received ?? 0 }} received</span
							>
						</p>
						<Button variant="outline" :disabled="stopping" @click="cancel">{{
							stopping ? 'Stopping…' : 'Cancel test job'
						}}</Button>
						<p class="explorer-note">
							Cancellation stops new work. In-flight writes may still succeed.
							Uncompleted messages can remain locked until their locks expire.
						</p>
					</div>
				</section>
				<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
				<template v-if="interrupted"
					><p class="inspector-warning">
						The final result is unknown. Progress counts are lower bounds; additional
						writes may have succeeded. Nothing was retried.
					</p>
					<Button :disabled="!!sb.busy" variant="outline" @click="check"
						>Check test job result</Button
					></template
				>
				<section v-if="result" aria-label="Test job result">
					<p role="status">{{ result.summary }}</p>
					<p class="explorer-note">
						{{ result.status }} · Receipt {{ result.operationId }}
					</p>
					<p v-if="result.sessionId" class="explorer-note">
						Session: {{ result.sessionId }}
					</p>
					<p v-if="result.lastMessageId" class="explorer-note">
						Last attempted message: {{ result.lastMessageId
						}}<span v-if="result.lastSequenceNumber">
							· Sequence {{ result.lastSequenceNumber }}</span
						>
					</p>
					<p v-if="result.uncertain" class="inspector-warning">
						<template v-if="result.uncertain === 1"
							>The last
							{{
								result.mode === 'send'
									? 'send'
									: result.settlement === 'complete'
										? 'completion'
										: result.settlement
							}}
							is uncertain.</template
						>
						<template v-else
							>{{ result.uncertain }} message outcomes are uncertain.</template
						>
						Review worker details and the target before another job. Confirmed counts
						exclude uncertain messages.
					</p>
					<TestJobStatistics :result="result" />
					<details v-if="result.deferredSequenceNumbers.length">
						<summary>
							Deferred sequences ({{ result.deferredSequenceNumbers.length }})
						</summary>
						<p class="explorer-note">
							Keep these exact sequences for retrieval. References are available
							during this app session.
						</p>
						<textarea
							readonly
							aria-label="Test deferred sequences"
							:value="result.deferredSequenceNumbers.join('\n')"
							rows="3"
						/>
					</details>
					<p v-if="result.referenceWarning" class="inspector-warning">
						{{ result.referenceWarning }}
					</p>
					<p v-if="result.cleanupWarning" class="inspector-warning">
						{{ result.cleanupWarning }}
					</p>
					<label
						v-if="result.uncertain || result.cleanupWarning || result.referenceWarning"
						class="confirm-check"
						><input v-model="reviewed" type="checkbox" />I have reviewed this result
						before starting another test job.</label
					>
				</section>
				<Button
					v-if="operationId && !running"
					variant="outline"
					:disabled="!!sb.busy || unresolved"
					@click="prepare"
					>Prepare another test job</Button
				>
			</template>
		</DialogContent>
	</Dialog>
</template>
<style scoped>
.test-job-dialog {
	max-height: 90vh;
	overflow-y: auto;
}
.test-job-fields,
.test-job-metrics {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 1rem;
}
label {
	display: block;
}
select,
textarea {
	width: 100%;
	border: 1px solid var(--border);
	border-radius: 0.4rem;
	padding: 0.5rem;
	background: var(--background);
	color: var(--foreground);
}
textarea {
	font-family: monospace;
	resize: vertical;
}
.confirm-check {
	display: flex;
	align-items: flex-start;
	gap: 0.6rem;
	margin: 0.7rem 0;
}
progress {
	appearance: none;
	border: 0;
	border-radius: 3px;
	height: 6px;
	width: 100%;
	margin-top: 0.6rem;
	accent-color: var(--primary);
	background: var(--muted);
}
progress::-webkit-progress-bar {
	background: var(--muted);
	border-radius: 3px;
}
progress::-webkit-progress-value {
	background: var(--primary);
	border-radius: 3px;
}
progress::-moz-progress-bar {
	background: var(--primary);
}
.write-destination,
.explorer-note {
	overflow-wrap: anywhere;
}
</style>
