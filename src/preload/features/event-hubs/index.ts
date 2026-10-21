import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createEventHubsBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'connectIotHub'
	| 'listenEventHub'
	| 'getEventListenerResult'
	| 'exportEvents'
	| 'saveEventDrafts'
	| 'importEvents'
	| 'loadImportedEvents'
	| 'discardImportedEvents'
	| 'saveEventCheckpoint'
	| 'loadEventCheckpoint'
	| 'getEventAdminContext'
	| 'getEventAdminResource'
	| 'listEventPolicies'
	| 'changeEventAdminResource'
	| 'getEventAdminResult'
	| 'revealEventPolicyKey'
	| 'copyEventPolicyKey'
	| 'sendEventHub'
	| 'getEventHubSendResult'
	| 'connectEventHubs'
	| 'disconnectEventHubs'
	| 'listEventHubs'
	| 'getEventHubStatistics'
	| 'copyEventHubUrl'
	| 'getEventHub'
	| 'getEventHubPartition'
	| 'readEventHub'
	| 'getEventHubReadResult'
	| 'inspectEvent'
	| 'readEventBody'
> {
	return {
		connectIotHub: (request) => invoke('commander:iot-connect', request),
		listenEventHub: (request) => invoke('commander:eh-listen', request),
		getEventListenerResult: (request) => invoke('commander:eh-listen-result', request),
		exportEvents: (request) => invoke('commander:eh-files-export', request),
		saveEventDrafts: (request) => invoke('commander:eh-files-drafts', request),
		importEvents: (request) => invoke('commander:eh-files-import', request),
		loadImportedEvents: (request) => invoke('commander:eh-files-load', request),
		discardImportedEvents: (request) => invoke('commander:eh-files-discard', request),
		saveEventCheckpoint: (request) => invoke('commander:eh-checkpoint-save', request),
		loadEventCheckpoint: (request) => invoke('commander:eh-checkpoint-load', request),
		getEventAdminContext: (request) => invoke('commander:eh-admin-context', request),
		getEventAdminResource: (request) => invoke('commander:eh-admin-get', request),
		listEventPolicies: (request) => invoke('commander:eh-admin-policies', request),
		changeEventAdminResource: (request) => invoke('commander:eh-admin-change', request),
		getEventAdminResult: (request) => invoke('commander:eh-admin-result', request),
		revealEventPolicyKey: (request) => invoke('commander:eh-admin-key', request),
		copyEventPolicyKey: (request) => invoke('commander:eh-admin-copy', request),
		sendEventHub: (request) => invoke('commander:eh-send', request),
		getEventHubSendResult: (request) => invoke('commander:eh-send-result', request),
		connectEventHubs: (request) => invoke('commander:eh-connect', request),
		disconnectEventHubs: (request) => invoke('commander:eh-disconnect', request),
		listEventHubs: (request) => invoke('commander:eh-list', request),
		getEventHubStatistics: (request) => invoke('commander:eh-statistics', request),
		copyEventHubUrl: (request) => invoke('commander:eh-copy-url', request),
		getEventHub: (request) => invoke('commander:eh-hub', request),
		getEventHubPartition: (request) => invoke('commander:eh-partition', request),
		readEventHub: (request) => invoke('commander:eh-read', request),
		getEventHubReadResult: (request) => invoke('commander:eh-read-result', request),
		inspectEvent: (request) => invoke('commander:eh-inspect', request),
		readEventBody: (request) => invoke('commander:eh-body', request),
	}
}
