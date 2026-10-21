import type { CommanderApi } from '@shared/contracts'

export const eventHubsApi: Pick<
	CommanderApi,
	| 'changeEventAdminResource'
	| 'connectEventHubs'
	| 'connectIotHub'
	| 'copyEventHubUrl'
	| 'copyEventPolicyKey'
	| 'discardImportedEvents'
	| 'disconnectEventHubs'
	| 'exportEvents'
	| 'getEventAdminContext'
	| 'getEventAdminResource'
	| 'getEventAdminResult'
	| 'getEventHub'
	| 'getEventHubPartition'
	| 'getEventHubReadResult'
	| 'getEventHubSendResult'
	| 'getEventHubStatistics'
	| 'getEventListenerResult'
	| 'importEvents'
	| 'inspectEvent'
	| 'listEventHubs'
	| 'listEventPolicies'
	| 'listenEventHub'
	| 'loadEventCheckpoint'
	| 'loadImportedEvents'
	| 'openDeviceLogin'
	| 'readEventBody'
	| 'readEventHub'
	| 'revealEventPolicyKey'
	| 'saveEventCheckpoint'
	| 'saveEventDrafts'
	| 'sendEventHub'
> = {
	changeEventAdminResource: (...args) => window.commander.changeEventAdminResource(...args),
	connectEventHubs: (...args) => window.commander.connectEventHubs(...args),
	connectIotHub: (...args) => window.commander.connectIotHub(...args),
	copyEventHubUrl: (...args) => window.commander.copyEventHubUrl(...args),
	copyEventPolicyKey: (...args) => window.commander.copyEventPolicyKey(...args),
	discardImportedEvents: (...args) => window.commander.discardImportedEvents(...args),
	disconnectEventHubs: (...args) => window.commander.disconnectEventHubs(...args),
	exportEvents: (...args) => window.commander.exportEvents(...args),
	getEventAdminContext: (...args) => window.commander.getEventAdminContext(...args),
	getEventAdminResource: (...args) => window.commander.getEventAdminResource(...args),
	getEventAdminResult: (...args) => window.commander.getEventAdminResult(...args),
	getEventHub: (...args) => window.commander.getEventHub(...args),
	getEventHubPartition: (...args) => window.commander.getEventHubPartition(...args),
	getEventHubReadResult: (...args) => window.commander.getEventHubReadResult(...args),
	getEventHubSendResult: (...args) => window.commander.getEventHubSendResult(...args),
	getEventHubStatistics: (...args) => window.commander.getEventHubStatistics(...args),
	getEventListenerResult: (...args) => window.commander.getEventListenerResult(...args),
	importEvents: (...args) => window.commander.importEvents(...args),
	inspectEvent: (...args) => window.commander.inspectEvent(...args),
	listEventHubs: (...args) => window.commander.listEventHubs(...args),
	listEventPolicies: (...args) => window.commander.listEventPolicies(...args),
	listenEventHub: (...args) => window.commander.listenEventHub(...args),
	loadEventCheckpoint: (...args) => window.commander.loadEventCheckpoint(...args),
	loadImportedEvents: (...args) => window.commander.loadImportedEvents(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
	readEventBody: (...args) => window.commander.readEventBody(...args),
	readEventHub: (...args) => window.commander.readEventHub(...args),
	revealEventPolicyKey: (...args) => window.commander.revealEventPolicyKey(...args),
	saveEventCheckpoint: (...args) => window.commander.saveEventCheckpoint(...args),
	saveEventDrafts: (...args) => window.commander.saveEventDrafts(...args),
	sendEventHub: (...args) => window.commander.sendEventHub(...args),
}
