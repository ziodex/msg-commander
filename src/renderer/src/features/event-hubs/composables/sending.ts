import { eventHubsApi } from '@/features/event-hubs/api'

import type { EventHubSend } from '@shared/contracts/event-hubs/sending'

import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsSending(
	state: Pick<
		EventHubsState,
		'connection' | 'busy' | 'error' | 'sendId' | 'sendResult' | 'sendInterrupted' | 'lifetime'
	>,
	actions: Pick<EventHubsActions, 'task'>,
) {
	const { connection, busy, error, sendId, sendResult, sendInterrupted, lifetime } = state
	const { task } = actions
	function clearSend() {
		sendId.value = ''
		sendResult.value = undefined
		sendInterrupted.value = false
	}
	async function send(setup: Omit<EventHubSend, 'id' | 'connectionId'>) {
		if (!connection.value || busy.value || sendId.value) return
		const connectionId = connection.value.connectionId,
			ticket = lifetime.generation
		sendInterrupted.value = false
		await task(
			'Send Event Hubs events',
			async (id) => {
				sendId.value = id
				try {
					const response = await eventHubsApi.sendEventHub({ ...setup, id, connectionId })
					if (
						ticket === lifetime.generation &&
						!response.ok &&
						[
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'BACKEND_UNAVAILABLE',
							'INVALID_REQUEST',
						].includes(response.error.code)
					)
						sendInterrupted.value = true
					return response
				} catch (cause) {
					if (ticket === lifetime.generation) sendInterrupted.value = true
					throw cause
				}
			},
			(value) => {
				sendResult.value = value
			},
			(value) => ({
				status:
					value.status === 'unknown' || value.status === 'failed'
						? 'failed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'completed',
				message: value.summary,
			}),
		)
	}
	async function recoverSend() {
		if (!connection.value || !sendId.value || busy.value) return
		const connectionId = connection.value.connectionId,
			operationId = sendId.value
		await task(
			'Recover event send result',
			(id) => eventHubsApi.getEventHubSendResult({ id, connectionId, operationId }),
			(value) => {
				if (value) {
					sendResult.value = value
					sendInterrupted.value = false
				} else
					error.value =
						'No retained receipt is available. Events may have been accepted. Review the destination before reconnecting and sending again.'
			},
		)
	}
	return { clearSend, send, recoverSend }
}
