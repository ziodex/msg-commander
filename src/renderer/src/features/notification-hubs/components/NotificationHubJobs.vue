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
	DialogFooter,
} from '@/shared/ui/dialog'
import { useNotificationHubRegistrations } from '@/features/notification-hubs/stores/notification-hub-registrations'
import {
	jobTypes,
	jobLabels,
	nhJobDraftSchema,
	nhJobGetSchema,
	type NotificationHubJobDraft,
} from '@shared/contracts/notification-hubs/jobs'
const emit = defineEmits<{ close: [] }>()
const registrations = useNotificationHubRegistrations()
const type = ref<NotificationHubJobDraft['type']>('ExportRegistrations'),
	input = ref(''),
	output = ref(''),
	ack = ref(false),
	jobId = ref(''),
	error = ref('')
const pending = computed(() => !!registrations.busy)
const review = computed(() => registrations.jobReview)
const receipt = computed(() => registrations.jobOutcome)
const selected = computed(() => registrations.selectedJob)
const reviewExpired = computed(() =>
	review.value ? Date.parse(review.value.expiresAt) <= Date.now() : false,
)
watch(
	[type, input, output],
	() => {
		registrations.jobReview = undefined
		ack.value = false
		error.value = ''
	},
	{ flush: 'sync' },
)
watch(review, () => {
	ack.value = false
})
async function preview() {
	const draft = nhJobDraftSchema.safeParse({
		type: type.value,
		importFileUri: type.value === 'ExportRegistrations' ? null : input.value,
		outputContainerUri: output.value,
	})
	if (!draft.success) {
		error.value = draft.error.issues[0].message
		return
	}
	error.value = ''
	const result = await registrations.previewJob(draft.data)
	if (result) {
		input.value = output.value = ''
		registrations.jobReview = result
	}
}
async function lookup() {
	const parsed = nhJobGetSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: registrations.connection?.connectionId,
		jobId: jobId.value,
	})
	if (!parsed.success) {
		error.value = 'Enter an Azure job ID using letters, digits, hyphens or underscores.'
		return
	}
	error.value = ''
	await registrations.getJob(jobId.value)
}
async function close() {
	if (pending.value) return
	input.value = output.value = ''
	await registrations.discardJob()
	emit('close')
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && close()">
		<DialogContent
			class="nh-bulk-jobs"
			:show-close-button="false"
			@escape-key-down="pending && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
		>
			<DialogHeader>
				<DialogTitle>Azure Storage registration jobs</DialogTitle>
				<DialogDescription
					>Bulk jobs for {{ registrations.connection?.hubName }} ·
					{{ registrations.connection?.namespace }}. Requires Azure Standard tier and
					Manage access.</DialogDescription
				>
			</DialogHeader>
			<div class="nh-bulk-body">
				<p class="form-warning">
					Azure runs these jobs independently. Cancelling a local request, closing this
					dialog or disconnecting cannot stop an accepted Azure job.
				</p>
				<form v-if="!review" class="nh-form" @submit.prevent="preview">
					<label
						>Bulk job action<select
							v-model="type"
							aria-label="Bulk job action"
							:disabled="pending"
						>
							<option v-for="kind in jobTypes" :key="kind" :value="kind">
								{{ jobLabels[kind] }}
							</option>
						</select></label
					>
					<label v-if="type !== 'ExportRegistrations'"
						>Input blob SAS URL<Input
							v-model="input"
							aria-label="Input blob SAS URL"
							type="password"
							autocomplete="off"
							:disabled="pending"
					/></label>
					<label
						>Output container SAS URL<Input
							v-model="output"
							aria-label="Output container SAS URL"
							type="password"
							autocomplete="off"
							:disabled="pending"
					/></label>
					<p class="field-hint">
						Use existing Azure Blob Storage URLs with SAS access. Input needs read
						permission; output needs write/list permission. Tokens stay private and are
						cleared after review. Azure reads the input directly; use one registration
						XML definition per line, not a Commander file archive.
					</p>
					<Button type="submit" :disabled="registrations.blocked">Review bulk job</Button>
				</form>
				<section v-else class="nh-job-review" aria-label="Bulk job review">
					<h3>{{ jobLabels[review.type] }}</h3>
					<dl>
						<dt>Hub</dt>
						<dd>{{ review.namespace }} / {{ review.hubName }}</dd>
						<dt v-if="review.importFileUri">Input blob</dt>
						<dd v-if="review.importFileUri">{{ review.importFileUri }}</dd>
						<dt>Output container</dt>
						<dd>{{ review.outputContainerUri }}</dd>
						<dt>Review expires</dt>
						<dd>{{ new Date(review.expiresAt).toLocaleTimeString() }}</dd>
					</dl>
					<p v-for="warning in review.warnings" :key="warning" class="form-warning">
						{{ warning }}
					</p>
					<label class="nh-check"
						><input type="checkbox" v-model="ack" :disabled="pending" />I reviewed this
						hub, job action and Storage locations, including the full registration scope
						and any permanent changes.</label
					>
					<div class="nh-actions">
						<Button
							:disabled="!ack || registrations.blocked || reviewExpired"
							@click="registrations.submitJob()"
							>Submit reviewed Azure job</Button
						><Button
							variant="outline"
							:disabled="pending"
							@click="registrations.discardJob()"
							>Change bulk job</Button
						>
					</div>
				</section>
				<section
					v-if="receipt"
					class="nh-registration-receipt"
					aria-label="Bulk job submission receipt"
				>
					<p role="status">
						<strong>{{ receipt.status }}</strong> · {{ receipt.summary }}
					</p>
					<p class="field-hint">Receipt {{ receipt.operationId }}</p>
					<Button
						variant="outline"
						size="sm"
						:disabled="pending"
						@click="registrations.recoverJob()"
						>Check retained bulk job receipt</Button
					>
					<label v-if="receipt.status === 'unknown'" class="nh-check"
						><input
							type="checkbox"
							v-model="registrations.jobReviewed"
							:disabled="pending"
						/>I checked Azure jobs and reviewed the uncertain submission before another
						job.</label
					>
				</section>
				<div class="nh-actions">
					<Button variant="outline" :disabled="pending" @click="registrations.listJobs()"
						>Refresh Azure jobs</Button
					>
				</div>
				<form class="nh-job-lookup" @submit.prevent="lookup">
					<label
						>Azure job ID<Input
							v-model="jobId"
							aria-label="Azure job ID"
							:disabled="pending" /></label
					><Button variant="outline" type="submit" :disabled="pending || !jobId"
						>Look up Azure job</Button
					>
				</form>
				<section v-if="registrations.jobPage" aria-label="Azure bulk jobs">
					<p class="field-hint">
						{{ registrations.jobPage.items.length }} returned jobs · captured
						{{ new Date(registrations.jobPage.capturedAt).toLocaleTimeString() }}.
						Refresh to check progress.
					</p>
					<p v-if="registrations.jobPage.moreAvailable" class="form-warning">
						Azure has more jobs. Look up a specific job ID to check it.
					</p>
					<div class="nh-job-table">
						<table class="nh-policy-table">
							<thead>
								<tr>
									<th>Azure job ID</th>
									<th>Action</th>
									<th>Status</th>
									<th>Progress</th>
									<th></th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="job in registrations.jobPage.items" :key="job.jobId">
									<td>{{ job.jobId }}</td>
									<td>
										{{
											job.type === 'Unknown' ? 'Unknown' : jobLabels[job.type]
										}}
									</td>
									<td>{{ job.status }}</td>
									<td>
										{{
											job.progress === null
												? 'Not supplied'
												: job.progress + '%'
										}}
									</td>
									<td>
										<Button
											size="sm"
											variant="outline"
											:disabled="pending"
											@click="registrations.getJob(job.jobId)"
											>Check job {{ job.jobId }}</Button
										>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</section>
				<section v-if="selected" aria-label="Azure bulk job details" class="nh-job-review">
					<h3>{{ selected.jobId }} · {{ selected.status }}</h3>
					<dl>
						<dt>Job type</dt>
						<dd>
							{{ selected.type === 'Unknown' ? 'Unknown' : jobLabels[selected.type] }}
						</dd>
						<dt>Azure progress</dt>
						<dd>
							{{
								selected.progress === null
									? 'Not supplied'
									: selected.progress + '%'
							}}
						</dd>
						<dt>Created</dt>
						<dd>{{ selected.createdAt ?? 'Not supplied' }}</dd>
						<dt>Updated</dt>
						<dd>{{ selected.updatedAt ?? 'Not supplied' }}</dd>
						<dt>Output container</dt>
						<dd>{{ selected.outputContainerUri ?? 'Not supplied' }}</dd>
						<dt v-if="selected.importFileUri">Input blob</dt>
						<dd v-if="selected.importFileUri">{{ selected.importFileUri }}</dd>
						<dt>Output file</dt>
						<dd>{{ selected.outputFile ?? 'Not supplied' }}</dd>
						<dt>Failure file</dt>
						<dd>{{ selected.failuresFile ?? 'Not supplied' }}</dd>
					</dl>
					<p
						v-if="selected.hasFailure || selected.status === 'Failed'"
						class="form-warning"
					>
						Azure reported a job failure. Inspect the failure file in Storage; private
						service error details are withheld.
					</p>
					<p class="field-hint">
						Completed is Azure's job status. Inspect output and failure files in Azure
						Storage for individual registration results. Displayed locations omit access
						tokens.
					</p>
					<Button
						variant="outline"
						:disabled="pending"
						@click="registrations.getJob(selected.jobId)"
						>Refresh selected job</Button
					>
				</section>
				<p v-if="error || registrations.error" role="alert" class="form-error">
					{{ error || registrations.error }}
				</p>
			</div>
			<DialogFooter
				><span v-if="pending" role="status">{{ registrations.busy }}…</span
				><Button v-if="pending" variant="outline" @click="registrations.cancel()"
					>Cancel local job request</Button
				><Button variant="outline" :disabled="pending" @click="close"
					>Close Azure jobs</Button
				></DialogFooter
			>
		</DialogContent>
	</Dialog>
</template>
<style>
.nh-bulk-jobs {
	width: min(960px, calc(100vw - 32px));
	max-width: 960px;
	max-height: calc(100vh - 48px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.nh-bulk-body {
	overflow-y: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 18px;
	padding: 2px;
}
.nh-job-review {
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.nh-job-review dl {
	display: grid;
	grid-template-columns: 130px minmax(0, 1fr);
	gap: 8px 12px;
	font-size: 13px;
}
.nh-job-review dt {
	color: var(--muted-foreground);
}
.nh-job-review dd {
	overflow-wrap: anywhere;
}
.nh-job-lookup {
	display: flex;
	align-items: end;
	gap: 12px;
	flex-wrap: wrap;
}
.nh-job-lookup label {
	flex: 1;
	min-width: 240px;
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.nh-job-table {
	overflow-x: auto;
}
.nh-job-table table {
	min-width: 620px;
}
</style>
