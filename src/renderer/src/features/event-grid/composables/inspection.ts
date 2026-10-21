import { eventGridApi } from '@/features/event-grid/api'

import { eventGridPath, type EventGridTarget } from '@shared/contracts/event-grid/core'
import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridInspection(
	state: Pick<EventGridState, 'connection' | 'details' | 'inspection' | 'busy'>,
	actions: Pick<EventGridActions, 'task'>,
) {
	const { connection, details, inspection, busy } = state
	const { task } = actions
	async function inspect(target: EventGridTarget) {
		if (busy.value || !connection.value) return
		inspection.value = { ...target }
		details.value = undefined
		await refreshInspection()
	}
	async function refreshInspection() {
		if (!connection.value || !inspection.value) return
		const target = { ...inspection.value },
			connectionId = connection.value.connectionId
		await task(
			'Inspect Event Grid ' + target.kind,
			(id) => eventGridApi.getEventGrid({ id, connectionId, target }),
			(value) => {
				if (inspection.value && eventGridPath(inspection.value) === eventGridPath(target))
					details.value = value
			},
		)
	}
	function closeInspection() {
		inspection.value = undefined
		details.value = undefined
	}
	return { inspect, refreshInspection, closeInspection }
}
