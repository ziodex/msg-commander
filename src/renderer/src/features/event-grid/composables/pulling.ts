import { eventGridApi } from '@/features/event-grid/api'
import type {
	EventGridReceive,
	EventGridSettle,
	EventGridPullOutcome,
} from '@shared/contracts/event-grid/pulling'

import type { DesktopResult } from '@shared/contracts'
import { eventGridPath, type EventGridTarget } from '@shared/contracts/event-grid/core'
import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridPulling(
	state: Pick<
		EventGridState,
		| 'connection'
		| 'error'
		| 'received'
		| 'eventInspection'
		| 'pullOutcome'
		| 'pullReviewed'
		| 'lifetime'
		| 'writeBlocked'
	>,
	actions: Pick<EventGridActions, 'task'>,
) {
	const {
		connection,
		error,
		received,
		eventInspection,
		pullOutcome,
		pullReviewed,
		lifetime,
		writeBlocked,
	} = state
	const { task } = actions
	async function refreshReceived(target: EventGridTarget, clear = false) {
		if (target.kind !== 'subscription') return
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		return task(
			clear ? 'Clear finished Event Grid snapshots' : 'Refresh received Event Grid events',
			(id) =>
				(clear ? eventGridApi.clearReceivedEventGrid : eventGridApi.listReceivedEventGrid)({
					id,
					connectionId,
					target: { ...target },
				}),
			(value) => {
				received.value[eventGridPath(target)] = value
				if (
					eventInspection.value &&
					eventGridPath(eventInspection.value.item.target) === eventGridPath(target)
				) {
					const item = value.find((v) => v.handle === eventInspection.value!.item.handle)
					if (item) eventInspection.value.item = item
					else eventInspection.value = undefined
				}
			},
		)
	}
	async function inspectEvent(target: EventGridTarget, handle: string) {
		if (target.kind !== 'subscription') return
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		eventInspection.value = undefined
		return task(
			'Inspect received Event Grid event',
			(id) =>
				eventGridApi.inspectReceivedEventGrid({
					id,
					connectionId,
					target: { ...target },
					handle,
				}),
			(value) => {
				eventInspection.value = value
			},
		)
	}
	async function pull(
		setup:
			| Omit<EventGridReceive, 'id' | 'connectionId'>
			| Omit<EventGridSettle, 'id' | 'connectionId'>,
	) {
		if (!connection.value || writeBlocked.value) return
		setup = JSON.parse(JSON.stringify(setup))
		const connectionId = connection.value.connectionId,
			ticket = lifetime.generation
		pullReviewed.value = false
		const value = await task(
			'Event Grid: ' + ('handles' in setup ? setup.action : 'receive'),
			async (id) => {
				try {
					const result =
						'handles' in setup
							? await eventGridApi.settleEventGrid({ ...setup, id, connectionId })
							: await eventGridApi.receiveEventGrid({ ...setup, id, connectionId })
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
					// Never automatically retry a receive or settlement with a missing response.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						target: { ...setup.target },
						action: 'handles' in setup ? setup.action : 'receive',
						requested: 'handles' in setup ? setup.handles.length : setup.maxEvents,
						confirmed: 0,
						failed: 0,
						uncertain: 'handles' in setup ? setup.handles.length : setup.maxEvents,
						elapsedMs: 0,
						status: 'unknown',
						reason: 'error',
						summary:
							'The final response is unavailable. Counts are unverified. Recover the retained receipt and refresh received events before another operation. Nothing was retried.',
						handles: 'handles' in setup ? [...setup.handles] : [],
						results: [],
					},
				} satisfies DesktopResult<EventGridPullOutcome>
			},
			(result) => {
				pullOutcome.value = result
			},
			(result) => ({
				status: result.status === 'limited' ? 'completed' : result.status,
				message: result.summary + ' Receipt: ' + result.operationId,
			}),
		)
		if (ticket === lifetime.generation && value) await refreshReceived(setup.target)
		return value
	}
	const receive = (setup: Omit<EventGridReceive, 'id' | 'connectionId'>) => pull(setup)
	const settle = (setup: Omit<EventGridSettle, 'id' | 'connectionId'>) => pull(setup)
	async function recoverPull() {
		if (!connection.value || !pullOutcome.value) return
		const connectionId = connection.value.connectionId,
			operationId = pullOutcome.value.operationId,
			target = { ...pullOutcome.value.target },
			ticket = lifetime.generation
		const value = await task(
			'Recover Event Grid pull receipt',
			(id) => eventGridApi.getEventGridPullResult({ id, connectionId, operationId }),
			(value) => {
				if (value) {
					pullOutcome.value = value
					pullReviewed.value = false
				}
			},
		)
		if (ticket !== lifetime.generation) return
		if (value !== undefined) await refreshReceived(target)
		if (value === null)
			error.value =
				'No retained receipt is available. Missing evidence does not prove success or failure. Locks expire in Azure; nothing was retried.'
	}
	return { refreshReceived, inspectEvent, pull, receive, settle, recoverPull }
}
