import type { CommanderApi } from '@shared/contracts'

export const serviceBusApi: Pick<
	CommanderApi,
	| 'acceptSession'
	| 'bulkPurgeMessages'
	| 'cancelOperation'
	| 'cancelScheduledMessages'
	| 'closeReceiver'
	| 'closeSessionScan'
	| 'connectAuthorization'
	| 'connectNamespace'
	| 'copyAuthorizationKey'
	| 'createAuthorizationRule'
	| 'createEntity'
	| 'createRule'
	| 'deleteAuthorizationRule'
	| 'deleteEntity'
	| 'deleteRule'
	| 'discardImport'
	| 'disconnectNamespace'
	| 'executeBulkEntities'
	| 'executeEntityCopy'
	| 'exportMessages'
	| 'finishEntityRename'
	| 'forgetDeferredReference'
	| 'getAuthorizationRule'
	| 'getBulkEntityResult'
	| 'getBulkPurgeResult'
	| 'getEntity'
	| 'getEntityConfiguration'
	| 'getEntityCopyResult'
	| 'getEntityRenameResult'
	| 'getListener'
	| 'getOperationOutcome'
	| 'getPurgeResult'
	| 'getReceiveDeleteResult'
	| 'getResendResult'
	| 'getRule'
	| 'getSessionState'
	| 'importMessages'
	| 'inspectMessage'
	| 'listAuthorizationRules'
	| 'listDeferredReferences'
	| 'listDeliveries'
	| 'listEntities'
	| 'listRules'
	| 'listRuntimeCounts'
	| 'listScheduledMessages'
	| 'listSessions'
	| 'loadImportedMessages'
	| 'openDeviceLogin'
	| 'peekMessages'
	| 'previewBulkEntities'
	| 'previewBulkPurge'
	| 'previewEntityCopy'
	| 'purgeMessages'
	| 'readMessageBody'
	| 'receiveDelete'
	| 'receiveMessages'
	| 'regenerateAuthorizationKey'
	| 'releaseSession'
	| 'renewSessionLock'
	| 'replayMessage'
	| 'resendDeadLetters'
	| 'resendSnapshot'
	| 'revealAuthorizationKey'
	| 'reviewEntityRename'
	| 'saveDrafts'
	| 'saveResendReceipt'
	| 'sendBatch'
	| 'sendMessage'
	| 'setSessionState'
	| 'settleListener'
	| 'settleMessage'
	| 'startListener'
	| 'stopListener'
	| 'updateAuthorizationRule'
	| 'updateEntity'
	| 'updateRule'
> = {
	acceptSession: (...args) => window.commander.acceptSession(...args),
	bulkPurgeMessages: (...args) => window.commander.bulkPurgeMessages(...args),
	cancelOperation: (...args) => window.commander.cancelOperation(...args),
	cancelScheduledMessages: (...args) => window.commander.cancelScheduledMessages(...args),
	closeReceiver: (...args) => window.commander.closeReceiver(...args),
	closeSessionScan: (...args) => window.commander.closeSessionScan(...args),
	connectAuthorization: (...args) => window.commander.connectAuthorization(...args),
	connectNamespace: (...args) => window.commander.connectNamespace(...args),
	copyAuthorizationKey: (...args) => window.commander.copyAuthorizationKey(...args),
	createAuthorizationRule: (...args) => window.commander.createAuthorizationRule(...args),
	createEntity: (...args) => window.commander.createEntity(...args),
	createRule: (...args) => window.commander.createRule(...args),
	deleteAuthorizationRule: (...args) => window.commander.deleteAuthorizationRule(...args),
	deleteEntity: (...args) => window.commander.deleteEntity(...args),
	deleteRule: (...args) => window.commander.deleteRule(...args),
	discardImport: (...args) => window.commander.discardImport(...args),
	disconnectNamespace: (...args) => window.commander.disconnectNamespace(...args),
	executeBulkEntities: (...args) => window.commander.executeBulkEntities(...args),
	executeEntityCopy: (...args) => window.commander.executeEntityCopy(...args),
	exportMessages: (...args) => window.commander.exportMessages(...args),
	finishEntityRename: (...args) => window.commander.finishEntityRename(...args),
	forgetDeferredReference: (...args) => window.commander.forgetDeferredReference(...args),
	getAuthorizationRule: (...args) => window.commander.getAuthorizationRule(...args),
	getBulkEntityResult: (...args) => window.commander.getBulkEntityResult(...args),
	getBulkPurgeResult: (...args) => window.commander.getBulkPurgeResult(...args),
	getEntity: (...args) => window.commander.getEntity(...args),
	getEntityConfiguration: (...args) => window.commander.getEntityConfiguration(...args),
	getEntityCopyResult: (...args) => window.commander.getEntityCopyResult(...args),
	getEntityRenameResult: (...args) => window.commander.getEntityRenameResult(...args),
	getListener: (...args) => window.commander.getListener(...args),
	getOperationOutcome: (...args) => window.commander.getOperationOutcome(...args),
	getPurgeResult: (...args) => window.commander.getPurgeResult(...args),
	getReceiveDeleteResult: (...args) => window.commander.getReceiveDeleteResult(...args),
	getResendResult: (...args) => window.commander.getResendResult(...args),
	getRule: (...args) => window.commander.getRule(...args),
	getSessionState: (...args) => window.commander.getSessionState(...args),
	importMessages: (...args) => window.commander.importMessages(...args),
	inspectMessage: (...args) => window.commander.inspectMessage(...args),
	listAuthorizationRules: (...args) => window.commander.listAuthorizationRules(...args),
	listDeferredReferences: (...args) => window.commander.listDeferredReferences(...args),
	listDeliveries: (...args) => window.commander.listDeliveries(...args),
	listEntities: (...args) => window.commander.listEntities(...args),
	listRules: (...args) => window.commander.listRules(...args),
	listRuntimeCounts: (...args) => window.commander.listRuntimeCounts(...args),
	listScheduledMessages: (...args) => window.commander.listScheduledMessages(...args),
	listSessions: (...args) => window.commander.listSessions(...args),
	loadImportedMessages: (...args) => window.commander.loadImportedMessages(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
	peekMessages: (...args) => window.commander.peekMessages(...args),
	previewBulkEntities: (...args) => window.commander.previewBulkEntities(...args),
	previewBulkPurge: (...args) => window.commander.previewBulkPurge(...args),
	previewEntityCopy: (...args) => window.commander.previewEntityCopy(...args),
	purgeMessages: (...args) => window.commander.purgeMessages(...args),
	readMessageBody: (...args) => window.commander.readMessageBody(...args),
	receiveDelete: (...args) => window.commander.receiveDelete(...args),
	receiveMessages: (...args) => window.commander.receiveMessages(...args),
	regenerateAuthorizationKey: (...args) => window.commander.regenerateAuthorizationKey(...args),
	releaseSession: (...args) => window.commander.releaseSession(...args),
	renewSessionLock: (...args) => window.commander.renewSessionLock(...args),
	replayMessage: (...args) => window.commander.replayMessage(...args),
	resendDeadLetters: (...args) => window.commander.resendDeadLetters(...args),
	resendSnapshot: (...args) => window.commander.resendSnapshot(...args),
	revealAuthorizationKey: (...args) => window.commander.revealAuthorizationKey(...args),
	reviewEntityRename: (...args) => window.commander.reviewEntityRename(...args),
	saveDrafts: (...args) => window.commander.saveDrafts(...args),
	saveResendReceipt: (...args) => window.commander.saveResendReceipt(...args),
	sendBatch: (...args) => window.commander.sendBatch(...args),
	sendMessage: (...args) => window.commander.sendMessage(...args),
	setSessionState: (...args) => window.commander.setSessionState(...args),
	settleListener: (...args) => window.commander.settleListener(...args),
	settleMessage: (...args) => window.commander.settleMessage(...args),
	startListener: (...args) => window.commander.startListener(...args),
	stopListener: (...args) => window.commander.stopListener(...args),
	updateAuthorizationRule: (...args) => window.commander.updateAuthorizationRule(...args),
	updateEntity: (...args) => window.commander.updateEntity(...args),
	updateRule: (...args) => window.commander.updateRule(...args),
}
