import type { AppEvent } from '@shared/contracts'
import type { Job } from '@/shared/workspace/store'
import { progressFor } from '@/shared/workspace/progress'

export function receiveEventGridProgress(jobs: Job[], event: AppEvent): boolean {
	switch (event.type) {
		case 'event-grid-pull-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job?.status === 'running') {
				job.progress = event
				job.percent = (100 * event.confirmed) / event.requested
				job.message = `${event.confirmed}/${event.requested} confirmed · ${event.failed} failed · ${event.uncertain} uncertain · ${event.phase}`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		case 'event-grid-publish-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job?.status === 'running') {
				job.progress = event
				job.percent = (100 * event.confirmed) / event.totalEvents
				job.message = `${event.confirmed}/${event.totalEvents} events confirmed · ${event.uncertain} uncertain · ${event.phase}`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		default:
			return false
	}
}

export function eventGridJob(job: Job | undefined) {
	return job
		? {
				...job,
				eventGridPull: progressFor(job, 'event-grid-pull-progress'),
				eventGridPublish: progressFor(job, 'event-grid-publish-progress'),
			}
		: undefined
}
