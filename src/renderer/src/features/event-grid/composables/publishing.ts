import { eventGridApi } from '@/features/event-grid/api'

import type {
	EventGridPublish,
	EventGridPublishOutcome,
} from '@shared/contracts/event-grid/publishing'

import type { DesktopResult } from '@shared/contracts'

import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridPublishing(
	state: Pick<
		EventGridState,
		'connection' | 'error' | 'publishOutcome' | 'publishReviewed' | 'writeBlocked'
	>,
	actions: Pick<EventGridActions, 'task'>,
) {
	const { connection, error, publishOutcome, publishReviewed, writeBlocked } = state
	const { task } = actions
	async function publish(setup: Omit<EventGridPublish, 'id' | 'connectionId'>) {
		if (writeBlocked.value || !connection.value) return
		setup = JSON.parse(JSON.stringify(setup))
		const connectionId = connection.value.connectionId
		publishReviewed.value = false
		return task(
			'Publish Event Grid CloudEvents',
			async (id) => {
				try {
					const result = await eventGridApi.publishEventGrid({
						...setup,
						id,
						connectionId,
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
					// Recover a receipt; never automatically repeat a publish request.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						topicName: setup.topicName,
						totalEvents: setup.drafts.length,
						confirmed: 0,
						confirmedBatches: 0,
						uncertain: setup.drafts.length,
						elapsedMs: 0,
						status: 'unknown',
						reason: 'error',
						lastBatchFirstIndex: null,
						lastBatchCount: 0,
						summary:
							'The final response is unavailable. Counts are unverified. Recover the retained receipt before sending again. Nothing was retried.',
					},
				} satisfies DesktopResult<EventGridPublishOutcome>
			},
			(value) => {
				publishOutcome.value = value
			},
			(value) => ({
				status: value.status === 'limited' ? 'completed' : value.status,
				message: value.summary + ' Receipt: ' + value.operationId,
			}),
		)
	}
	async function recoverPublish() {
		if (!connection.value || !publishOutcome.value) return
		const connectionId = connection.value.connectionId,
			operation = publishOutcome.value.operationId
		const value = await task('Recover Event Grid publish receipt', (id) =>
			eventGridApi.getEventGridPublishResult({ id, connectionId, operationId: operation }),
		)
		if (value) {
			publishOutcome.value = value
			publishReviewed.value = false
		} else if (value === null)
			error.value =
				'No retained publish receipt is available. Missing evidence does not prove failure; check Azure before sending again.'
	}
	return { publish, recoverPublish }
}
