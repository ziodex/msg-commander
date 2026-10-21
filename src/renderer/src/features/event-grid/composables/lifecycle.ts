import { eventGridApi } from '@/features/event-grid/api'

import { useWorkspace } from '@/shared/workspace/store'

import { type EventGridConnect } from '@shared/contracts/event-grid/core'
import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridLifecycle(
	state: Pick<
		EventGridState,
		| 'connection'
		| 'topics'
		| 'subscriptions'
		| 'expanded'
		| 'details'
		| 'inspection'
		| 'busy'
		| 'operationId'
		| 'error'
		| 'outcome'
		| 'reviewed'
		| 'publishOutcome'
		| 'publishReviewed'
		| 'received'
		| 'eventInspection'
		| 'pullOutcome'
		| 'pullReviewed'
		| 'lifetime'
	>,
	actions: Pick<EventGridActions, 'task' | 'loadTopics'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const {
		connection,
		topics,
		subscriptions,
		expanded,
		details,
		inspection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		publishOutcome,
		publishReviewed,
		received,
		eventInspection,
		pullOutcome,
		pullReviewed,
		lifetime,
	} = state
	const { task, loadTopics } = actions
	function reset() {
		lifetime.generation++
		received.value = {}
		eventInspection.value = undefined
		pullOutcome.value = undefined
		pullReviewed.value = false
		publishOutcome.value = undefined
		publishReviewed.value = false
		outcome.value = undefined
		reviewed.value = false
		connection.value = undefined
		topics.value = undefined
		subscriptions.value = {}
		expanded.value = []
		details.value = undefined
		inspection.value = undefined
		busy.value = operationId.value = error.value = ''
	}
	async function connect(setup: Omit<EventGridConnect, 'id'>) {
		if (busy.value) return
		reset()
		const ticket = lifetime.generation
		const value = await task(
			'Connect Event Grid',
			(id) =>
				eventGridApi.connectEventGrid({
					...setup,
					management: { ...setup.management },
					id,
				}),
			(value) => {
				connection.value = value
			},
		)
		if (value && ticket === lifetime.generation) await loadTopics()
	}
	async function disconnect() {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Disconnect Event Grid',
			(id) => eventGridApi.disconnectEventGrid({ id, connectionId }),
			reset,
		)
	}
	const cancel = () => operationId.value && workspace.cancel(operationId.value)
	return { reset, connect, disconnect, cancel }
}
