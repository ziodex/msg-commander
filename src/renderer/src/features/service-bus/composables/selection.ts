import type { ServiceBusState } from '../model/state'

export function createServiceBusSelection(
	state: Pick<
		ServiceBusState,
		| 'activeTabId'
		| 'selectionView'
		| 'selected'
		| 'details'
		| 'messages'
		| 'subQueue'
		| 'fromSequence'
		| 'message'
		| 'body'
		| 'bodyStart'
		| 'nextBodyOffset'
	>,
) {
	const {
		activeTabId,
		selectionView,
		selected,
		details,
		messages,
		subQueue,
		fromSequence,
		message,
		body,
		bodyStart,
		nextBodyOffset,
	} = state
	function clearInspection() {
		message.value = undefined
		body.value = new Uint8Array()
		bodyStart.value = 0
		nextBodyOffset.value = null
	}
	function clearEntity() {
		activeTabId.value = ''
		selectionView.value = 'entity'
		selected.value = undefined
		details.value = undefined
		messages.value = undefined
		subQueue.value = 'active'
		fromSequence.value = '0'
		clearInspection()
	}
	return { clearInspection, clearEntity }
}
