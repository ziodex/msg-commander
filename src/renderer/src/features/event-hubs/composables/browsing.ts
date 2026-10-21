import { eventHubsApi } from '@/features/event-hubs/api'
import { eventTabKey } from '@/features/event-hubs/lib/event-tabs'

import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsBrowsing(
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
		| 'tabs'
	>,
	actions: Pick<EventHubsActions, 'activateTab' | 'openTab' | 'clearEvent' | 'task'>,
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
		tabs,
	} = state
	const { activateTab, openTab, clearEvent, task } = actions
	async function listHubs(more = false) {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Browse Event Hubs',
			(id) =>
				eventHubsApi.listEventHubs({
					id,
					connectionId,
					kind: 'hubs',
					hubName: '',
					continuationToken: more ? hubs.value.continuationToken : null,
				}),
			(page) => {
				hubs.value = {
					items: more ? [...hubs.value.items, ...page.items] : page.items,
					continuationToken: page.continuationToken,
				}
			},
		)
	}
	async function listGroups(more = false) {
		if (!connection.value || !hubName.value) return
		const connectionId = connection.value.connectionId,
			name = hubName.value
		await task(
			'Browse consumer groups',
			(id) =>
				eventHubsApi.listEventHubs({
					id,
					connectionId,
					kind: 'groups',
					hubName: name,
					continuationToken: more ? groups.value.continuationToken : null,
				}),
			(page) => {
				groups.value = {
					items: more ? [...groups.value.items, ...page.items] : page.items,
					continuationToken: page.continuationToken,
				}
			},
		)
	}
	async function selectHub(name: string) {
		if (!connection.value || busy.value) return
		const key = eventTabKey(name)
		if (tabs.value.some((tab) => tab.id === key)) {
			await activateTab(key)
			return
		}
		if (!openTab(name)) return
		const connectionId = connection.value.connectionId
		hubName.value = name
		hub.value = undefined
		partition.value = undefined
		partitionId.value = ''
		groups.value = { items: [], continuationToken: null }
		clearEvent()
		if (
			await task(
				'Inspect Event Hub',
				(id) => eventHubsApi.getEventHub({ id, connectionId, hubName: name }),
				(value) => {
					hub.value = value
					if (!hubs.value.items.some((item) => item.name === name))
						hubs.value.items.push({
							name,
							status: null,
							partitionCount: value.partitionIds.length,
							userMetadata: null,
						})
				},
			)
		) {
			if (connection.value?.managementAvailable) await listGroups()
		}
	}
	async function selectPartition(value: string, group = consumerGroup.value) {
		if (!connection.value || !hubName.value || busy.value) return
		const key = eventTabKey(hubName.value, value, group)
		if (tabs.value.some((tab) => tab.id === key)) {
			await activateTab(key)
			return
		}
		if (!openTab(hubName.value, value, group)) return
		const connectionId = connection.value.connectionId,
			name = hubName.value
		consumerGroup.value = group
		partitionId.value = value
		partition.value = undefined
		await task(
			'Inspect partition',
			(id) =>
				eventHubsApi.getEventHubPartition({
					id,
					connectionId,
					hubName: name,
					partitionId: value,
				}),
			(value) => {
				partition.value = value
			},
		)
	}
	return { listHubs, listGroups, selectHub, selectPartition }
}
