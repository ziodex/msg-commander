import { eventHubsApi } from '@/features/event-hubs/api'

import { decodeBase64 } from '@/shared/lib/message-body'
import type { EventSummary } from '@shared/contracts/event-hubs/core'
import type { EventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'

export function createEventHubsInspection(
	state: Pick<
		EventHubsState,
		'connection' | 'busy' | 'event' | 'body' | 'bodyOffset' | 'nextOffset'
	>,
	actions: Pick<EventHubsActions, 'task'>,
) {
	const { connection, busy, event, body, bodyOffset, nextOffset } = state
	const { task } = actions
	function clearEvent() {
		event.value = undefined
		body.value = new Uint8Array()
		bodyOffset.value = 0
		nextOffset.value = null
	}
	async function inspect(summary: EventSummary) {
		if (!connection.value || !summary.snapshotId || busy.value) return
		clearEvent()
		const connectionId = connection.value.connectionId,
			snapshotId = summary.snapshotId
		if (
			await task(
				'Inspect event',
				(id) => eventHubsApi.inspectEvent({ id, connectionId, snapshotId }),
				(value) => {
					event.value = value
				},
			)
		)
			await readBody(0)
	}
	async function readBody(offset: number) {
		if (!connection.value || !event.value?.summary.snapshotId) return
		const connectionId = connection.value.connectionId,
			snapshotId = event.value.summary.snapshotId
		await task(
			'Read event body',
			(id) =>
				eventHubsApi.readEventBody({ id, connectionId, snapshotId, offset, count: 65536 }),
			(value) => {
				body.value = decodeBase64(value.base64)
				bodyOffset.value = value.offset
				nextOffset.value = value.nextOffset
			},
		)
	}
	return { clearEvent, inspect, readBody }
}
