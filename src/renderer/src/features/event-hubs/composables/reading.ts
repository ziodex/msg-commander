import { eventHubsApi } from '@/features/event-hubs/api'

import type { EventHubRead } from '@shared/contracts/event-hubs/core'
import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsReading(
	state: Pick<
		EventHubsState,
		| 'connection'
		| 'hubName'
		| 'partitionId'
		| 'consumerGroup'
		| 'busy'
		| 'error'
		| 'readId'
		| 'result'
		| 'interrupted'
		| 'serviceName'
		| 'lifetime'
	>,
	actions: Pick<EventHubsActions, 'clearEvent' | 'task'>,
) {
	const {
		connection,
		hubName,
		partitionId,
		consumerGroup,
		busy,
		error,
		readId,
		result,
		interrupted,
		serviceName,
		lifetime,
	} = state
	const { clearEvent, task } = actions
	async function read(
		setup: Omit<
			EventHubRead,
			'id' | 'connectionId' | 'hubName' | 'partitionId' | 'consumerGroup'
		>,
	) {
		if (!connection.value || !hubName.value || !partitionId.value || busy.value) return
		const input = {
			...setup,
			connectionId: connection.value.connectionId,
			hubName: hubName.value,
			partitionId: partitionId.value,
			consumerGroup: consumerGroup.value,
		}
		const ticket = lifetime.generation
		result.value = undefined
		clearEvent()
		interrupted.value = false
		await task(
			`Read ${serviceName.value === 'IoT Hub' ? 'IoT Hub' : 'Event Hub'} partition`,
			async (id) => {
				readId.value = id
				try {
					const response = await eventHubsApi.readEventHub({ id, ...input })
					if (
						ticket === lifetime.generation &&
						!response.ok &&
						['TIMEOUT', 'BACKEND_UNAVAILABLE', 'INVALID_REQUEST'].includes(
							response.error.code,
						)
					)
						interrupted.value = true
					return response
				} catch (cause) {
					if (ticket === lifetime.generation) interrupted.value = true
					throw cause
				}
			},
			(value) => {
				result.value = value
			},
			(value) => ({
				status:
					value.status === 'failed'
						? 'failed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'completed',
				message: value.summary,
			}),
		)
	}
	async function recoverRead() {
		if (!connection.value || !readId.value) return
		const connectionId = connection.value.connectionId,
			operationId = readId.value
		await task(
			'Recover Event Hubs read result',
			(id) => eventHubsApi.getEventHubReadResult({ id, connectionId, operationId }),
			(value) => {
				if (value) {
					result.value = value
					interrupted.value = false
				} else
					error.value =
						'No retained result is available. You can explicitly read again from the original position; no checkpoint was saved.'
			},
		)
	}
	return { read, recoverRead }
}
