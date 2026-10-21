import { eventGridApi } from '@/features/event-grid/api'

import type {
	EventGridAdminChange,
	EventGridAdminOutcome,
} from '@shared/contracts/event-grid/administration'

import type { DesktopResult } from '@shared/contracts'
import { type EventGridTarget } from '@shared/contracts/event-grid/core'
import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridAdministration(
	state: Pick<
		EventGridState,
		| 'connection'
		| 'topics'
		| 'subscriptions'
		| 'error'
		| 'outcome'
		| 'reviewed'
		| 'writeBlocked'
	>,
	actions: Pick<EventGridActions, 'task' | 'loadTopics' | 'loadSubscriptions'>,
) {
	const { connection, topics, subscriptions, error, outcome, reviewed, writeBlocked } = state
	const { task, loadTopics, loadSubscriptions } = actions
	async function adminGet(target: EventGridTarget) {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		return task('Review Event Grid ' + target.kind, (id) =>
			eventGridApi.getEventGridAdmin({ id, connectionId, target: { ...target } }),
		)
	}
	async function change(setup: Omit<EventGridAdminChange, 'id' | 'connectionId'>) {
		if (writeBlocked.value || !connection.value) return
		const connectionId = connection.value.connectionId
		setup = JSON.parse(JSON.stringify(setup))
		reviewed.value = false
		return task(
			'Event Grid: ' + setup.action,
			async (id) => {
				try {
					const result = await eventGridApi.changeEventGrid({
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
					// A missing response does not prove rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						target: { ...setup.target },
						action: setup.action,
						status: 'unknown',
						summary:
							'The final response is unavailable. Recover the retained receipt and inspect Azure before another change. Nothing was retried.',
					},
				} satisfies DesktopResult<EventGridAdminOutcome>
			},
			(value) => {
				outcome.value = value
			},
			(value) => ({
				status: value.status === 'confirmed' ? 'completed' : value.status,
				message: value.summary + ' Receipt: ' + value.operationId,
			}),
		)
	}
	async function recover() {
		if (!connection.value || !outcome.value) return
		const connectionId = connection.value.connectionId,
			operation = outcome.value.operationId
		const value = await task('Recover Event Grid receipt', (id) =>
			eventGridApi.getEventGridAdminResult({ id, connectionId, operationId: operation }),
		)
		if (value) {
			outcome.value = value
			reviewed.value = false
		} else if (value === null)
			error.value =
				'No retained receipt is available. Inspect Azure; this does not prove the change failed.'
	}
	async function afterChange(value: EventGridAdminOutcome) {
		if (!['confirmed', 'accepted'].includes(value.status)) return
		if (value.target.kind === 'topic') {
			await loadTopics()
			while (
				value.action !== 'delete' &&
				topics.value?.continuationToken &&
				!topics.value.items.some((i) => i.name === value.target.topicName)
			) {
				const previous = topics.value.continuationToken
				await loadTopics(true)
				if (error.value || topics.value.continuationToken === previous) break
			}
		} else if (value.target.topicName) {
			await loadSubscriptions(value.target.topicName)
			while (
				value.action !== 'delete' &&
				subscriptions.value[value.target.topicName]?.continuationToken &&
				!subscriptions.value[value.target.topicName].items.some(
					(i) => i.name === value.target.subscriptionName,
				)
			) {
				const previous = subscriptions.value[value.target.topicName].continuationToken
				await loadSubscriptions(value.target.topicName, true)
				if (
					error.value ||
					subscriptions.value[value.target.topicName].continuationToken === previous
				)
					break
			}
		}
	}
	return { adminGet, change, recover, afterChange }
}
