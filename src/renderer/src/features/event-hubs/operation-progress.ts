import type { AppEvent } from '@shared/contracts'
import type { Job } from '@/shared/workspace/store'
import { progressFor } from '@/shared/workspace/progress'

export function receiveEventHubsProgress(jobs: Job[], event: AppEvent): boolean {
	switch (event.type) {
		case 'event-hub-listen-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job?.status === 'running') {
				job.progress = event
				job.percent = (100 * event.received) / event.maxEvents
				job.message = `${event.received}/${event.maxEvents} events retained · ${event.activeReceivers} active receivers · ${event.phase}`
				job.describeFailure = () =>
					`${event.received} events retained so far. Recover the listener result; no local checkpoint was saved automatically.`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		case 'event-hub-send-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				job.percent = (100 * event.confirmed) / event.totalEvents
				job.message = `${event.confirmed}/${event.totalEvents} events confirmed · ${event.phase}`
				job.describeFailure = () =>
					`${event.confirmed} events confirmed so far. Further batches may have been accepted; check the retained result before sending again. Nothing was retried.`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		case 'event-hub-read-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				job.percent = (100 * event.received) / event.maxEvents
				job.message = `${event.received}/${event.maxEvents} events read · ${event.phase}`
				job.describeFailure = () =>
					`${event.received} events read so far. Recover the retained result or explicitly read again; no checkpoint was saved.`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		default:
			return false
	}
}

export function eventHubsJob(job: Job | undefined) {
	return job
		? {
				...job,
				eventHubListen: progressFor(job, 'event-hub-listen-progress'),
				eventHubSend: progressFor(job, 'event-hub-send-progress'),
				eventHubRead: progressFor(job, 'event-hub-read-progress'),
			}
		: undefined
}
