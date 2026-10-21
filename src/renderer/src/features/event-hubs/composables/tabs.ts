import { eventHubsApi } from '@/features/event-hubs/api'
import { eventTabKey, saveEventTabs } from '@/features/event-hubs/lib/event-tabs'

import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsTabs(
	state: Pick<
		EventHubsState,
		| 'connection'
		| 'groups'
		| 'hubName'
		| 'hub'
		| 'partition'
		| 'partitionId'
		| 'consumerGroup'
		| 'busy'
		| 'error'
		| 'readId'
		| 'result'
		| 'interrupted'
		| 'tabs'
		| 'activeTabId'
	>,
	actions: Pick<EventHubsActions, 'clearEvent' | 'task' | 'listGroups'>,
) {
	const {
		connection,
		groups,
		hubName,
		hub,
		partition,
		partitionId,
		consumerGroup,
		busy,
		error,
		readId,
		result,
		interrupted,
		tabs,
		activeTabId,
	} = state
	const { clearEvent, task, listGroups } = actions
	function rememberTab() {
		const tab = tabs.value.find((tab) => tab.id === activeTabId.value)
		if (tab)
			Object.assign(tab, {
				hub: hub.value,
				groups: groups.value,
				partition: partition.value,
				result: result.value,
				readId: readId.value,
				readConsumerGroup: consumerGroup.value,
				interrupted: interrupted.value,
			})
	}
	function persistTabs() {
		if (connection.value) saveEventTabs(connection.value.profileId, tabs.value)
	}
	async function activateTab(id: string) {
		if (!connection.value || busy.value || activeTabId.value === id) return
		const tab = tabs.value.find((tab) => tab.id === id)
		if (!tab) return
		rememberTab()
		hubName.value = tab.hubName
		hub.value = tab.hub
		groups.value = tab.groups ?? { items: [], continuationToken: null }
		partitionId.value = tab.partitionId
		consumerGroup.value = tab.readConsumerGroup ?? tab.consumerGroup
		partition.value = tab.partition
		result.value = tab.result
		readId.value = tab.readId ?? ''
		interrupted.value = tab.interrupted ?? false
		activeTabId.value = id
		error.value = ''
		clearEvent()
		const connectionId = connection.value.connectionId
		if (!hub.value)
			await task(
				'Inspect Event Hub',
				(requestId) =>
					eventHubsApi.getEventHub({ id: requestId, connectionId, hubName: tab.hubName }),
				(value) => {
					hub.value = value
				},
			)
		if (tab.groups === undefined && connection.value?.managementAvailable) await listGroups()
		if (!partition.value && tab.partitionId)
			await task(
				'Inspect partition',
				(requestId) =>
					eventHubsApi.getEventHubPartition({
						id: requestId,
						connectionId,
						hubName: tab.hubName,
						partitionId: tab.partitionId,
					}),
				(value) => {
					partition.value = value
				},
			)
	}
	async function closeTab(id: string) {
		if (busy.value) return
		const index = tabs.value.findIndex((tab) => tab.id === id)
		if (index < 0) return
		tabs.value.splice(index, 1)
		persistTabs()
		if (activeTabId.value === id) {
			activeTabId.value = ''
			hubName.value = ''
			hub.value = undefined
			partition.value = undefined
			partitionId.value = ''
			result.value = undefined
			readId.value = ''
			clearEvent()
			const next = tabs.value[Math.min(index, tabs.value.length - 1)]
			if (next) await activateTab(next.id)
		}
	}
	function openTab(name: string, id = '', group = '$Default') {
		const key = eventTabKey(name, id, group)
		if (tabs.value.length >= 12) {
			error.value = 'Close a tab before opening another (12 maximum).'
			return false
		}
		rememberTab()
		tabs.value.push({
			id: key,
			hubName: name,
			partitionId: id,
			consumerGroup: group,
			hub: hub.value,
			groups: groups.value,
		})
		activeTabId.value = key
		result.value = undefined
		readId.value = ''
		interrupted.value = false
		clearEvent()
		persistTabs()
		return true
	}
	return { rememberTab, persistTabs, activateTab, closeTab, openTab }
}
