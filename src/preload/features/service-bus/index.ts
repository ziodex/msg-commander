import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createServiceBusBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'startListener'
	| 'getListener'
	| 'stopListener'
	| 'settleListener'
	| 'previewEntityCopy'
	| 'executeEntityCopy'
	| 'getEntityCopyResult'
	| 'reviewEntityRename'
	| 'finishEntityRename'
	| 'getEntityRenameResult'
	| 'connectAuthorization'
	| 'listAuthorizationRules'
	| 'getAuthorizationRule'
	| 'revealAuthorizationKey'
	| 'createAuthorizationRule'
	| 'updateAuthorizationRule'
	| 'deleteAuthorizationRule'
	| 'regenerateAuthorizationKey'
	| 'copyAuthorizationKey'
	| 'previewBulkEntities'
	| 'executeBulkEntities'
	| 'getBulkEntityResult'
	| 'previewBulkPurge'
	| 'bulkPurgeMessages'
	| 'getBulkPurgeResult'
	| 'receiveDelete'
	| 'getReceiveDeleteResult'
	| 'purgeMessages'
	| 'resendDeadLetters'
	| 'saveResendReceipt'
	| 'getResendResult'
	| 'getPurgeResult'
	| 'listSessions'
	| 'closeSessionScan'
	| 'acceptSession'
	| 'releaseSession'
	| 'getSessionState'
	| 'setSessionState'
	| 'renewSessionLock'
	| 'exportMessages'
	| 'saveDrafts'
	| 'importMessages'
	| 'loadImportedMessages'
	| 'discardImport'
	| 'listRules'
	| 'getRule'
	| 'createRule'
	| 'updateRule'
	| 'deleteRule'
	| 'getEntityConfiguration'
	| 'createEntity'
	| 'updateEntity'
	| 'deleteEntity'
	| 'sendBatch'
	| 'listScheduledMessages'
	| 'cancelScheduledMessages'
	| 'resendSnapshot'
	| 'sendMessage'
	| 'receiveMessages'
	| 'listDeferredReferences'
	| 'forgetDeferredReference'
	| 'listDeliveries'
	| 'closeReceiver'
	| 'settleMessage'
	| 'replayMessage'
	| 'getOperationOutcome'
	| 'connectNamespace'
	| 'disconnectNamespace'
	| 'listRuntimeCounts'
	| 'listEntities'
	| 'getEntity'
	| 'peekMessages'
	| 'inspectMessage'
	| 'readMessageBody'
> {
	return {
		startListener: (request) => invoke('commander:listener-start', request),
		getListener: (request) => invoke('commander:listener-status', request),
		stopListener: (request) => invoke('commander:listener-stop', request),
		settleListener: (request) => invoke('commander:listener-settle', request),
		previewEntityCopy: (request) => invoke('commander:entity-copy-preview', request),
		executeEntityCopy: (request) => invoke('commander:entity-copy-execute', request),
		getEntityCopyResult: (request) => invoke('commander:entity-copy-result', request),
		reviewEntityRename: (request) => invoke('commander:entity-rename-review', request),
		finishEntityRename: (request) => invoke('commander:entity-rename-finish', request),
		getEntityRenameResult: (request) => invoke('commander:entity-rename-result', request),
		connectAuthorization: (request) => invoke('commander:authorization-connect', request),
		listAuthorizationRules: (request) => invoke('commander:authorization-list', request),
		getAuthorizationRule: (request) => invoke('commander:authorization-get', request),
		revealAuthorizationKey: (request) => invoke('commander:authorization-key', request),
		createAuthorizationRule: (request) => invoke('commander:authorization-create', request),
		updateAuthorizationRule: (request) => invoke('commander:authorization-update', request),
		deleteAuthorizationRule: (request) => invoke('commander:authorization-delete', request),
		regenerateAuthorizationKey: (request) =>
			invoke('commander:authorization-regenerate', request),
		copyAuthorizationKey: (request) => invoke('commander:authorization-copy', request),
		previewBulkEntities: (request) => invoke('commander:sb-bulk-entity-preview', request),
		executeBulkEntities: (request) => invoke('commander:sb-bulk-entity-execute', request),
		getBulkEntityResult: (request) => invoke('commander:sb-bulk-entity-result', request),
		previewBulkPurge: (request) => invoke('commander:sb-bulk-purge-preview', request),
		bulkPurgeMessages: (request) => invoke('commander:sb-bulk-purge', request),
		getBulkPurgeResult: (request) => invoke('commander:sb-bulk-purge-result', request),
		receiveDelete: (request) => invoke('commander:sb-receive-delete', request),
		getReceiveDeleteResult: (request) => invoke('commander:sb-receive-delete-result', request),
		purgeMessages: (request) => invoke('commander:sb-purge', request),
		resendDeadLetters: (request) => invoke('commander:sb-dlq-resend', request),
		saveResendReceipt: (request) => invoke('commander:sb-dlq-resend-save', request),
		getResendResult: (request) => invoke('commander:sb-dlq-resend-result', request),
		getPurgeResult: (request) => invoke('commander:sb-purge-result', request),
		listSessions: (request) => invoke('commander:sessions', request),
		closeSessionScan: (request) => invoke('commander:sessions-close', request),
		acceptSession: (request) => invoke('commander:session-accept', request),
		releaseSession: (request) => invoke('commander:session-release', request),
		getSessionState: (request) => invoke('commander:session-state', request),
		setSessionState: (request) => invoke('commander:session-state-set', request),
		renewSessionLock: (request) => invoke('commander:session-renew', request),
		exportMessages: (request) => invoke('commander:files-export', request),
		saveDrafts: (request) => invoke('commander:files-save-drafts', request),
		importMessages: (request) => invoke('commander:files-import', request),
		loadImportedMessages: (request) => invoke('commander:files-load', request),
		discardImport: (request) => invoke('commander:files-discard', request),
		listRules: (request) => invoke('commander:sb-rules', request),
		getRule: (request) => invoke('commander:sb-rule', request),
		createRule: (request) => invoke('commander:sb-rule-create', request),
		updateRule: (request) => invoke('commander:sb-rule-update', request),
		deleteRule: (request) => invoke('commander:sb-rule-delete', request),
		getEntityConfiguration: (request) => invoke('commander:sb-entity-config', request),
		createEntity: (request) => invoke('commander:sb-entity-create', request),
		updateEntity: (request) => invoke('commander:sb-entity-update', request),
		deleteEntity: (request) => invoke('commander:sb-entity-delete', request),
		sendBatch: (request) => invoke('commander:sb-send-batch', request),
		listScheduledMessages: (request) => invoke('commander:sb-scheduled', request),
		cancelScheduledMessages: (request) => invoke('commander:sb-scheduled-cancel', request),
		resendSnapshot: (request) => invoke('commander:sb-snapshot-resend', request),
		sendMessage: (request) => invoke('commander:sb-send', request),
		receiveMessages: (request) => invoke('commander:sb-receive', request),
		listDeferredReferences: (request) => invoke('commander:sb-deferred-list', request),
		forgetDeferredReference: (request) => invoke('commander:sb-deferred-forget', request),
		listDeliveries: (request) => invoke('commander:sb-deliveries', request),
		closeReceiver: (request) => invoke('commander:sb-close-receiver', request),
		settleMessage: (request) => invoke('commander:sb-settle', request),
		replayMessage: (request) => invoke('commander:sb-replay', request),
		getOperationOutcome: (request) => invoke('commander:sb-outcome', request),
		connectNamespace: (request) => invoke('commander:sb-connect', request),
		disconnectNamespace: (request) => invoke('commander:sb-disconnect', request),
		listRuntimeCounts: (request) => invoke('commander:sb-runtime', request),
		listEntities: (request) => invoke('commander:sb-list', request),
		getEntity: (request) => invoke('commander:sb-entity', request),
		peekMessages: (request) => invoke('commander:sb-peek', request),
		inspectMessage: (request) => invoke('commander:sb-inspect', request),
		readMessageBody: (request) => invoke('commander:sb-body', request),
	}
}
