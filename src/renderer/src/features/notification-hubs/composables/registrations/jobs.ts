import { notificationHubsApi } from '@/features/notification-hubs/api'
import type { DesktopResult } from '@shared/contracts'
import type {
	NotificationHubJobDraft,
	NotificationHubJobOutcome,
} from '@shared/contracts/notification-hubs/jobs'
import type { RegistrationActions } from '../../model/registration-actions'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationJobs(
	state: Pick<
		RegistrationState,
		| 'connection'
		| 'busy'
		| 'error'
		| 'jobReview'
		| 'jobOutcome'
		| 'jobPage'
		| 'selectedJob'
		| 'jobReviewed'
		| 'blocked'
	>,
	actions: Pick<RegistrationActions, 'task'>,
) {
	const {
		connection,
		busy,
		error,
		jobReview,
		jobOutcome,
		jobPage,
		selectedJob,
		jobReviewed,
		blocked,
	} = state
	const { task } = actions
	async function listJobs() {
		if (!connection.value) return
		return task(
			'Refresh Azure bulk jobs',
			(id) =>
				notificationHubsApi.listNotificationHubJobs({
					id,
					connectionId: connection.value!.connectionId,
				}),
			(value) => {
				jobPage.value = value
			},
		)
	}
	async function getJob(jobId: string) {
		if (!connection.value) return
		return task(
			'Check Azure bulk job',
			(id) =>
				notificationHubsApi.getNotificationHubJob({
					id,
					connectionId: connection.value!.connectionId,
					jobId,
				}),
			(value) => {
				selectedJob.value = value
				if (jobPage.value)
					jobPage.value.items = jobPage.value.items.map((item) =>
						item.jobId === value.jobId ? value : item,
					)
			},
		)
	}
	async function previewJob(draft: NotificationHubJobDraft) {
		if (!connection.value || blocked.value) return
		jobReview.value = undefined
		return task(
			'Review Azure bulk job',
			(id) =>
				notificationHubsApi.previewNotificationHubJob({
					id,
					connectionId: connection.value!.connectionId,
					draft: { ...draft },
				}),
			(value) => {
				jobReview.value = value
			},
		)
	}
	async function discardJob() {
		jobReview.value = undefined
		if (!connection.value || busy.value) return
		await task('Discard bulk job review', (id) =>
			notificationHubsApi.discardNotificationHubJob({
				id,
				connectionId: connection.value!.connectionId,
			}),
		)
	}
	async function submitJob() {
		if (!connection.value || !jobReview.value || blocked.value) return
		const reviewId = jobReview.value.reviewId
		jobReview.value = undefined
		jobReviewed.value = false
		return task(
			'Submit Azure bulk job',
			async (id) => {
				try {
					const result = await notificationHubsApi.submitNotificationHubJob({
						id,
						connectionId: connection.value!.connectionId,
						reviewId,
						acknowledge: true,
					})
					if (
						result.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
							'INVALID_REQUEST',
						].includes(result.error.code)
					)
						return result
				} catch {
					// A lost local response cannot prove rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown',
						summary:
							'Bulk job receipt unavailable. Check retained results and Azure jobs before submitting again. Azure may continue independently; nothing was retried.',
						job: null,
					},
				} satisfies DesktopResult<NotificationHubJobOutcome>
			},
			(value) => {
				jobOutcome.value = value
				if (value.job) selectedJob.value = value.job
			},
			(value) => ({
				status:
					value.status === 'accepted'
						? 'completed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: value.summary + ' Receipt: ' + value.operationId,
			}),
		)
	}
	async function recoverJob() {
		if (!connection.value || !jobOutcome.value) return
		const operationId = jobOutcome.value.operationId
		const value = await task('Check retained bulk job receipt', (id) =>
			notificationHubsApi.getNotificationHubJobResult({
				id,
				connectionId: connection.value!.connectionId,
				operationId,
			}),
		)
		if (value) {
			jobOutcome.value = value
			jobReviewed.value = false
			if (value.job) selectedJob.value = value.job
		} else if (value === null)
			error.value =
				'No retained receipt is available. Refresh Azure jobs; this does not prove submission failed.'
	}
	return { listJobs, getJob, previewJob, discardJob, submitJob, recoverJob }
}
