import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createEventGridBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'receiveEventGrid'
	| 'settleEventGrid'
	| 'listReceivedEventGrid'
	| 'clearReceivedEventGrid'
	| 'inspectReceivedEventGrid'
	| 'getEventGridPullResult'
	| 'publishEventGrid'
	| 'getEventGridPublishResult'
	| 'getEventGridAdmin'
	| 'changeEventGrid'
	| 'getEventGridAdminResult'
	| 'connectEventGrid'
	| 'disconnectEventGrid'
	| 'listEventGrid'
	| 'getEventGrid'
> {
	return {
		receiveEventGrid: (request) => invoke('commander:eg-pull-receive', request),
		settleEventGrid: (request) => invoke('commander:eg-pull-settle', request),
		listReceivedEventGrid: (request) => invoke('commander:eg-pull-list', request),
		clearReceivedEventGrid: (request) => invoke('commander:eg-pull-clear', request),
		inspectReceivedEventGrid: (request) => invoke('commander:eg-pull-inspect', request),
		getEventGridPullResult: (request) => invoke('commander:eg-pull-result', request),
		publishEventGrid: (request) => invoke('commander:eg-publish', request),
		getEventGridPublishResult: (request) => invoke('commander:eg-publish-result', request),
		getEventGridAdmin: (request) => invoke('commander:eg-admin-get', request),
		changeEventGrid: (request) => invoke('commander:eg-admin-change', request),
		getEventGridAdminResult: (request) => invoke('commander:eg-admin-result', request),
		connectEventGrid: (request) => invoke('commander:eg-connect', request),
		disconnectEventGrid: (request) => invoke('commander:eg-disconnect', request),
		listEventGrid: (request) => invoke('commander:eg-list', request),
		getEventGrid: (request) => invoke('commander:eg-get', request),
	}
}
