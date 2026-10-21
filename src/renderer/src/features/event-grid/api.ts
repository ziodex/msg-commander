import type { CommanderApi } from '@shared/contracts'

export const eventGridApi: Pick<
	CommanderApi,
	| 'changeEventGrid'
	| 'clearReceivedEventGrid'
	| 'connectEventGrid'
	| 'disconnectEventGrid'
	| 'getEventGrid'
	| 'getEventGridAdmin'
	| 'getEventGridAdminResult'
	| 'getEventGridPublishResult'
	| 'getEventGridPullResult'
	| 'inspectReceivedEventGrid'
	| 'listEventGrid'
	| 'listReceivedEventGrid'
	| 'openDeviceLogin'
	| 'publishEventGrid'
	| 'receiveEventGrid'
	| 'settleEventGrid'
> = {
	changeEventGrid: (...args) => window.commander.changeEventGrid(...args),
	clearReceivedEventGrid: (...args) => window.commander.clearReceivedEventGrid(...args),
	connectEventGrid: (...args) => window.commander.connectEventGrid(...args),
	disconnectEventGrid: (...args) => window.commander.disconnectEventGrid(...args),
	getEventGrid: (...args) => window.commander.getEventGrid(...args),
	getEventGridAdmin: (...args) => window.commander.getEventGridAdmin(...args),
	getEventGridAdminResult: (...args) => window.commander.getEventGridAdminResult(...args),
	getEventGridPublishResult: (...args) => window.commander.getEventGridPublishResult(...args),
	getEventGridPullResult: (...args) => window.commander.getEventGridPullResult(...args),
	inspectReceivedEventGrid: (...args) => window.commander.inspectReceivedEventGrid(...args),
	listEventGrid: (...args) => window.commander.listEventGrid(...args),
	listReceivedEventGrid: (...args) => window.commander.listReceivedEventGrid(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
	publishEventGrid: (...args) => window.commander.publishEventGrid(...args),
	receiveEventGrid: (...args) => window.commander.receiveEventGrid(...args),
	settleEventGrid: (...args) => window.commander.settleEventGrid(...args),
}
