import type { AppEvent } from '@shared/contracts'
import type { Job } from '@/shared/workspace/store'
import { progressFor } from '@/shared/workspace/progress'

export function receiveServiceBusProgress(jobs: Job[], event: AppEvent): boolean {
	switch (event.type) {
		case 'test-job-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				const confirmed = event.sent + event.settled
				job.percent = Math.min(100, (100 * confirmed) / event.maxMessages)
				job.message = `${confirmed}/${event.maxMessages} ${event.mode === 'send' ? 'sends' : event.settlement} confirmed · ${event.phase}`
				job.describeFailure = () =>
					`${event.sent} sends and ${event.settled} ${event.settlement} settlements confirmed so far. Final counts are unknown; additional writes may have succeeded. Nothing was retried.`
				job.percentOnCompletion = Math.min(100, job.percent ?? 0)
			}
			return true
		}
		case 'receive-delete-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				job.percent = undefined
				job.message = `${event.received}/${event.maxMessages} messages returned and consumed · ${event.phase}`
				job.describeFailure = () =>
					`${event.received} messages returned and consumed so far. The total consumed is unknown if a transfer was interrupted; nothing was retried.`
			}
			return true
		}
		case 'resend-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				job.percent = undefined
				job.message = `${event.sent} resends confirmed; ${event.removed} originals removed; ${event.uncertain} uncertain · ${event.phase}`
				job.describeFailure = (message) =>
					`${event.sent} resends confirmed so far. ${message ?? 'The final resend result is unknown; nothing was retried.'}`
			}
			return true
		}
		case 'bulk-entity-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job) {
				job.progress = event
				job.percent = event.phase === 'finished' ? 100 : undefined
				job.message = `${event.confirmed} entity changes confirmed; ${event.uncertain} uncertain · ${event.phase}`
			}
			return true
		}
		case 'bulk-purge-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job) {
				job.progress = event
				job.percent = undefined
				job.message = `${event.completed} deletions confirmed; ${event.uncertain} uncertain; ${event.skipped} retained by cutoff · ${event.items.filter((item) => item.result).length}/${event.items.length} targets finished`
				job.describeFailure = (message) =>
					`${event.completed} deletions confirmed so far. ${message ?? 'The final bulk purge result is unknown; nothing was retried.'}`
			}
			return true
		}
		case 'purge-progress': {
			const job = jobs.find((item) => item.id === event.operationId)
			if (job && job.status === 'running') {
				job.progress = event
				job.percent = undefined
				job.message = `${event.completed} deletions confirmed; ${event.uncertain} completion(s) uncertain${event.beforeEnqueueTime ? `; ${event.skipped} retained by cutoff` : ''} · ${event.phase}`
				job.describeFailure = (message) =>
					`${event.completed} deletions confirmed so far. ${message ?? 'The final purge result is unknown; nothing was retried.'}`
			}
			return true
		}
		default:
			return false
	}
}

export function serviceBusJob(job: Job | undefined) {
	return job
		? {
				...job,
				testJob: progressFor(job, 'test-job-progress'),
				receiveDelete: progressFor(job, 'receive-delete-progress'),
				resend: progressFor(job, 'resend-progress'),
				bulkEntities: progressFor(job, 'bulk-entity-progress'),
				bulkPurge: progressFor(job, 'bulk-purge-progress'),
				purge: progressFor(job, 'purge-progress'),
			}
		: undefined
}
