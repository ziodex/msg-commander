import { eventHubsApi } from '@/features/event-hubs/api'
import { readEventTabs } from '@/features/event-hubs/lib/event-tabs'

import { useWorkspace } from '@/shared/workspace/store'

import type { EventHubsConnect } from '@shared/contracts/event-hubs/core'
import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsLifecycle(
	state: Pick<
		EventHubsState,
		| 'connection'
		| 'hubs'
		| 'groups'
		| 'hubName'
		| 'hub'
		| 'partition'
		| 'partitionId'
		| 'consumerGroup'
		| 'busy'
		| 'error'
		| 'operationId'
		| 'readId'
		| 'result'
		| 'interrupted'
		| 'statistics'
		| 'urlNotice'
		| 'tabs'
		| 'activeTabId'
		| 'serviceName'
		| 'lifetime'
	>,
	actions: Pick<EventHubsActions, 'clearSend' | 'clearEvent' | 'task' | 'listHubs'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const {
		connection,
		hubs,
		groups,
		hubName,
		hub,
		partition,
		partitionId,
		consumerGroup,
		busy,
		error,
		operationId,
		readId,
		result,
		interrupted,
		statistics,
		urlNotice,
		tabs,
		activeTabId,
		serviceName,
		lifetime,
	} = state
	const { clearSend, clearEvent, task, listHubs } = actions
	function reset() {
		tabs.value = []
		activeTabId.value = ''

		lifetime.generation++
		statistics.value = undefined
		urlNotice.value = ''
		connection.value = undefined
		hubs.value = { items: [], continuationToken: null }
		groups.value = { items: [], continuationToken: null }
		hubName.value = ''
		hub.value = undefined
		partition.value = undefined
		partitionId.value = ''
		consumerGroup.value = '$Default'
		busy.value = error.value = operationId.value = readId.value = ''
		result.value = undefined
		interrupted.value = false
		clearEvent()
		clearSend()
	}
	async function connect(setup: Omit<EventHubsConnect, 'id'>, iot = false) {
		if (busy.value) return
		reset()
		if (
			await task(
				iot ? 'Connect to IoT Hub' : 'Connect to Event Hubs',
				(id) =>
					iot
						? eventHubsApi.connectIotHub({ id, profileId: setup.profileId })
						: eventHubsApi.connectEventHubs({ ...setup, id }),
				(value) => {
					connection.value = value
					tabs.value = readEventTabs(setup.profileId)
					if (value.initialHub) {
						hub.value = value.initialHub
						hubName.value = value.initialHub.name
						hubs.value = {
							items: [
								{
									name: value.initialHub.name,
									status: null,
									partitionCount: value.initialHub.partitionIds.length,
									userMetadata: null,
								},
							],
							continuationToken: null,
						}
					}
				},
			)
		) {
			if (connection.value?.managementAvailable) await listHubs()
		}
	}
	async function disconnect() {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			`Disconnect ${serviceName.value}`,
			(id) => eventHubsApi.disconnectEventHubs({ id, connectionId }),
			reset,
		)
	}
	async function cancel() {
		if (operationId.value) await workspace.cancel(operationId.value)
	}
	return { reset, connect, disconnect, cancel }
}
