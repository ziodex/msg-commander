import { eventHubsApi } from '@/features/event-hubs/api'

import type { EventHubUrlTarget } from '@shared/contracts/event-hubs/core'
import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsTools(
	state: Pick<EventHubsState, 'connection' | 'busy' | 'statistics' | 'urlNotice'>,
	actions: Pick<EventHubsActions, 'task'>,
) {
	const { connection, busy, statistics, urlNotice } = state
	const { task } = actions
	async function refreshStatistics(name: string) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		if (statistics.value?.hub.name !== name) statistics.value = undefined
		await task(
			'Refresh Event Hub statistics',
			(id) => eventHubsApi.getEventHubStatistics({ id, connectionId, hubName: name }),
			(value) => {
				statistics.value = value
			},
		)
	}
	async function copyUrl(target: EventHubUrlTarget, scheme: 'https' | 'sb' = 'https') {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		urlNotice.value = ''
		await task(
			'Copy Event Hubs URL',
			(id) => eventHubsApi.copyEventHubUrl({ id, connectionId, target, scheme }),
			() => {
				urlNotice.value = `${scheme.toUpperCase()} ${target.kind} URL copied.`
			},
		)
	}
	return { refreshStatistics, copyUrl }
}
