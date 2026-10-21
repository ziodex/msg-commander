import { executeEntityCopySchema, finishEntityRenameSchema } from '../../../shared/entity-copy'
import {
	deferredReferencesRequestSchema,
	forgetDeferredRequestSchema,
} from '../../../shared/deferred-messages'

import {
	receiveDeleteRequestSchema,
	receiveDeleteResultRequestSchema,
} from '../../../shared/contracts/service-bus/maintenance/index'
import {
	bulkEntityPreviewRequestSchema,
	bulkEntityExecuteRequestSchema,
	bulkEntityResultRequestSchema,
} from '../../../shared/bulk-entities'
import {
	bulkPurgePreviewRequestSchema,
	bulkPurgeRequestSchema,
	bulkPurgeResultRequestSchema,
} from '../../../shared/contracts/service-bus/maintenance/index'
import {
	listenerStartSchema,
	listenerStatusRequestSchema,
	listenerRequestSchema,
	listenerSettleSchema,
} from '../../../shared/listeners'
import { previewEntityCopySchema, entityCopyResultRequestSchema } from '../../../shared/entity-copy'
import {
	connectAuthorizationSchema,
	listAuthorizationSchema,
	getAuthorizationSchema,
	getAuthorizationKeySchema,
	copyAuthorizationKeySchema,
	createAuthorizationSchema,
	updateAuthorizationSchema,
	deleteAuthorizationSchema,
	regenerateAuthorizationSchema,
} from '../../../shared/authorization'
import {
	purgeRequestSchema,
	purgeResultRequestSchema,
} from '../../../shared/contracts/service-bus/maintenance/index'
import {
	resendRequestSchema,
	resendResultRequestSchema,
} from '../../../shared/contracts/service-bus/maintenance/index'
import {
	listSessionsRequestSchema,
	closeSessionScanRequestSchema,
	acceptSessionRequestSchema,
	sessionRequestSchema,
	setSessionStateRequestSchema,
} from '../../../shared/sessions'
import {
	listRulesRequestSchema,
	ruleRequestSchema,
	createRuleRequestSchema,
	updateRuleRequestSchema,
	deleteRuleRequestSchema,
} from '../../../shared/rules'
import { clipboard, dialog } from 'electron'

import { HostError } from '../../platform/backend'

import {
	exportMessagesRequestSchema,
	saveDraftsRequestSchema,
	importMessagesRequestSchema,
	loadImportedRequestSchema,
	discardImportRequestSchema,
} from '../../../shared/message-files'

import { resolveResendDestination, saveResendReceipt } from './recovery/resend-receipts'
import {
	entityConfigurationRequestSchema,
	createEntityRequestSchema,
	updateEntityRequestSchema,
	deleteEntityRequestSchema,
} from '../../../shared/entity-management'
import {
	deliveriesRequestSchema,
	outcomeRequestSchema,
	receiveRequestSchema,
	replayRequestSchema,
	batchRequestSchema,
	scheduledRequestSchema,
	cancelScheduledRequestSchema,
	sendRequestSchema,
	resendSnapshotRequestSchema,
	settleRequestSchema,
} from '../../../shared/message-operations'
import type { BackendMethods } from '../../../shared/contracts'
import {
	bodyRequestSchema,
	connectionRequestSchema,
	disconnectRequestSchema,
	entityRequestSchema,
	inspectRequestSchema,
	listRequestSchema,
	peekRequestSchema,
} from '../../../shared/service-bus'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerServiceBusIpc(
	context: Pick<
		MainIpcContext,
		'backend' | 'messageFiles' | 'serviceBus' | 'window' | 'workspace'
	>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	const mutation = async <
		K extends
			| 'sb.authorization.create'
			| 'sb.authorization.update'
			| 'sb.authorization.delete'
			| 'sb.authorization.regenerate'
			| 'sb.session.state.set'
			| 'sb.session.renew'
			| 'sb.send.batch'
			| 'sb.scheduled.cancel'
			| 'sb.snapshot.resend'
			| 'sb.send'
			| 'sb.settle'
			| 'sb.replay'
			| 'sb.entity.create'
			| 'sb.entity.update'
			| 'sb.entity.delete'
			| 'sb.rule.create'
			| 'sb.rule.update'
			| 'sb.rule.delete',
	>(
		method: K,
		value: BackendMethods[K]['params'],
		signal: AbortSignal,
	) => {
		context.serviceBus.require(value.connectionId)
		try {
			return await context.backend.request(method, value, { signal, timeout: 120000 })
		} catch (error) {
			if (method.startsWith('sb.authorization.') && !(error instanceof HostError))
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'The SAS rule response could not be validated. Its outcome may be unknown. Check the receipt before any further change.',
				)
			if (
				error instanceof HostError &&
				['CANCELLED', 'TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code)
			)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					`Operation ${value.id} was interrupted. Its broker outcome may be unknown. Check its receipt before retrying.`,
				)
			throw error
		}
	}
	handle('commander:listener-start', listenerStartSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.listener.start', value, {
				signal,
				timeout: 60000,
				waitForCancellation: true,
			})
		}),
	)
	handle('commander:listener-status', listenerStatusRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.listener.status', value, {
				signal,
				timeout: 10000,
			})
		}),
	)
	handle('commander:listener-stop', listenerRequestSchema, (value) =>
		withOperation(value.id, async () => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.listener.stop', value, { timeout: 60000 })
		}),
	)
	handle('commander:listener-settle', listenerSettleSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.listener.settle', value, {
				signal,
				timeout: 60000,
				waitForCancellation: true,
			})
		}),
	)
	handle('commander:sb-dlq-resend', resendRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			const destinationProfile = resolveResendDestination(value, context.workspace)
			context.serviceBus.require(value.connectionId)
			if (signal.aborted)
				throw new HostError(
					'CANCELLED',
					'Resend cancelled before connecting to the destination.',
				)
			try {
				return await context.backend.request(
					'sb.deadletters.resend',
					{ ...value, ...(destinationProfile ? { destinationProfile } : {}) },
					{
						signal,
						waitForCancellation: true,
						timeout: value.maxSeconds * 1000 + 60000,
					},
				)
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Resend ${value.id} was interrupted. Confirmed progress is only a lower bound; check its result before another resend.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-dlq-resend-save', resendResultRequestSchema, (value) =>
		withOperation(value.id, (signal) =>
			saveResendReceipt(
				value,
				signal,
				context.backend,
				(id) => context.serviceBus.require(id),
				async () => {
					const choice = await dialog.showSaveDialog(context.window!, {
						title: 'Save resend receipt',
						defaultPath: `resend-${value.operationId}.json`,
						filters: [{ name: 'Resend receipt', extensions: ['json'] }],
						properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
					})
					return choice.canceled ? undefined : choice.filePath
				},
			),
		),
	)
	handle('commander:sb-dlq-resend-result', resendResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.deadletters.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:sb-bulk-entity-preview', bulkEntityPreviewRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.entity.bulk.preview', value, {
				signal,
				timeout: 120000,
			})
		}),
	)
	handle('commander:sb-bulk-entity-execute', bulkEntityExecuteRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			try {
				return await context.backend.request('sb.entity.bulk.execute', value, {
					signal,
					waitForCancellation: true,
					timeout: 660000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Bulk entity action ${value.id} was interrupted. Confirmed progress is only a lower bound; check its result before another entity action.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-bulk-entity-result', bulkEntityResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.entity.bulk.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:sb-bulk-purge-preview', bulkPurgePreviewRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.purge.bulk.preview', value, {
				signal,
				timeout: 120000,
			})
		}),
	)
	handle('commander:sb-bulk-purge', bulkPurgeRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			try {
				return await context.backend.request('sb.purge.bulk', value, {
					signal,
					waitForCancellation: true,
					timeout: 660000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Bulk purge ${value.id} was interrupted. Confirmed progress is only a lower bound; check its result before another purge.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-bulk-purge-result', bulkPurgeResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.purge.bulk.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:sb-receive-delete', receiveDeleteRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			try {
				return await context.backend.request('sb.receive-delete', value, {
					signal,
					waitForCancellation: true,
					timeout: value.maxSeconds * 1000 + 60000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Receive-and-delete ${value.id} was interrupted. Returned-message counts are only a lower bound; additional messages may have been lost. Check its result before another run.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-receive-delete-result', receiveDeleteResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.receive-delete.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:sb-purge', purgeRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			try {
				return await context.backend.request('sb.purge', value, {
					signal,
					waitForCancellation: true,
					timeout: value.maxSeconds * 1000 + 60000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Purge ${value.id} was interrupted. Confirmed progress is only a lower bound; check its result before starting another purge.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-purge-result', purgeResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.purge.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:sessions', listSessionsRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.sessions', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sessions-close', closeSessionScanRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.sessions.close', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:session-accept', acceptSessionRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.session.accept', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:session-release', sessionRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.session.release', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:session-state', sessionRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await context.backend.request('sb.session.state', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:session-state-set', setSessionStateRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await mutation('sb.session.state.set', value, signal)
		}),
	)
	handle('commander:entity-copy-preview', previewEntityCopySchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity.copy.preview', value, {
				signal,
				timeout: 300000,
			})
		}),
	)
	handle('commander:entity-copy-result', entityCopyResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity.copy.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	handle('commander:entity-rename-review', entityCopyResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity.rename.review', value, {
				signal,
				timeout: 300000,
			})
		}),
	)
	handle('commander:entity-rename-result', entityCopyResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity.rename.result', value, {
				signal,
				timeout: 60000,
			})
		}),
	)
	async function copyMutation<K extends 'sb.entity.copy.execute' | 'sb.entity.rename.finish'>(
		method: K,
		value: BackendMethods[K]['params'],
		signal: AbortSignal,
	) {
		context.serviceBus.require(value.connectionId)
		try {
			return await context.backend.request(method, value, {
				signal,
				timeout: 300000,
				waitForCancellation: true,
			})
		} catch (error) {
			if (
				!(error instanceof HostError) ||
				['CANCELLED', 'TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code)
			)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'The copy/rename operation was interrupted. Inspect its receipt and Azure before another attempt; nothing was retried.',
				)
			throw error
		}
	}
	handle('commander:authorization-connect', connectAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.authorization.connect', value, {
				signal,
				timeout: 300000,
			})
		}),
	)
	handle('commander:authorization-list', listAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.authorization.list', value, {
				signal,
				timeout: 30000,
			})
		}),
	)
	handle('commander:authorization-get', getAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.authorization.get', value, {
				signal,
				timeout: 30000,
			})
		}),
	)
	handle('commander:authorization-key', getAuthorizationKeySchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.authorization.key', value, {
				signal,
				timeout: 30000,
			})
		}),
	)
	handle('commander:authorization-create', createAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return mutation('sb.authorization.create', value, signal)
		}),
	)
	handle('commander:authorization-update', updateAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return mutation('sb.authorization.update', value, signal)
		}),
	)
	handle('commander:authorization-delete', deleteAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return mutation('sb.authorization.delete', value, signal)
		}),
	)
	handle('commander:authorization-regenerate', regenerateAuthorizationSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return mutation('sb.authorization.regenerate', value, signal)
		}),
	)
	handle('commander:authorization-copy', copyAuthorizationKeySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			const { format, ...request } = value
			const key = await context.backend.request('sb.authorization.key', request, { signal })
			signal.throwIfAborted()
			context.serviceBus.require(value.connectionId)
			await clipboard.writeText(key[format])
			return null
		}),
	)
	handle('commander:session-renew', sessionRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.serviceBus.require(value.connectionId)
			return await mutation('sb.session.renew', value, signal)
		}),
	)
	handle('commander:files-export', exportMessagesRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.messageFiles!.export(value, signal)),
	)
	handle('commander:files-save-drafts', saveDraftsRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.messageFiles!.saveDrafts(value, signal)),
	)
	handle('commander:files-import', importMessagesRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.messageFiles!.import(value, signal)),
	)
	handle('commander:files-load', loadImportedRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.messageFiles!.load(value, signal)),
	)
	handle('commander:files-discard', discardImportRequestSchema, (value) =>
		context.messageFiles!.discard(value.connectionId, value.importId),
	)
	handle('commander:sb-rules', listRulesRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.rules', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sb-rule', ruleRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.rule', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sb-rule-create', createRuleRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.rule.create', value, signal)),
	)
	handle('commander:sb-rule-update', updateRuleRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.rule.update', value, signal)),
	)
	handle('commander:sb-rule-delete', deleteRuleRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.rule.delete', value, signal)),
	)
	handle('commander:sb-entity-config', entityConfigurationRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity-config', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sb-entity-create', createEntityRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.entity.create', value, signal)),
	)
	handle('commander:sb-entity-update', updateEntityRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.entity.update', value, signal)),
	)
	handle('commander:sb-entity-delete', deleteEntityRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.entity.delete', value, signal)),
	)
	handle('commander:sb-connect', connectionRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.messageFiles?.clear()
			return context.serviceBus.connect(
				value.id,
				context.workspace.getForBackend(value.profileId),
				signal,
			)
		}),
	)
	handle('commander:sb-send-batch', batchRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.send.batch', value, signal)),
	)
	handle('commander:sb-scheduled-cancel', cancelScheduledRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.scheduled.cancel', value, signal)),
	)
	handle('commander:sb-scheduled', scheduledRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.scheduled', value, { signal, timeout: 120000 })
		}),
	)
	handle('commander:sb-snapshot-resend', resendSnapshotRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.snapshot.resend', value, signal)),
	)
	handle('commander:sb-send', sendRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.send', value, signal)),
	)
	handle('commander:sb-settle', settleRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.settle', value, signal)),
	)
	handle('commander:sb-replay', replayRequestSchema, (value) =>
		withOperation(value.id, (signal) => mutation('sb.replay', value, signal)),
	)
	handle('commander:sb-receive', receiveRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.receive', value, { signal, timeout: 90000 })
		}),
	)
	handle('commander:sb-deferred-list', deferredReferencesRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.defer.list', value, { signal, timeout: 30000 })
		}),
	)
	handle('commander:sb-deferred-forget', forgetDeferredRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.defer.forget', value, { signal, timeout: 30000 })
		}),
	)
	handle('commander:sb-deliveries', deliveriesRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.deliveries', value, { signal, timeout: 90000 })
		}),
	)
	handle('commander:sb-close-receiver', deliveriesRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.close-receiver', value, { signal })
		}),
	)
	handle('commander:sb-outcome', outcomeRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.outcome', value, { signal, timeout: 90000 })
		}),
	)
	handle('commander:sb-disconnect', disconnectRequestSchema, (value) =>
		withOperation(value.id, () => context.serviceBus.disconnect(value.connectionId)),
	)
	handle('commander:sb-runtime', listRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.runtime', value, { signal, timeout: 30000 })
		}),
	)
	handle('commander:sb-list', listRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.list', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sb-entity', entityRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.entity', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:sb-peek', peekRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.peek', value, { signal, timeout: 120000 })
		}),
	)
	handle('commander:sb-inspect', inspectRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.inspect', value, { signal })
		}),
	)
	handle('commander:sb-body', bodyRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.serviceBus.require(value.connectionId)
			return context.backend.request('sb.body', value, { signal })
		}),
	)

	handle('commander:entity-copy-execute', executeEntityCopySchema, (value) =>
		withOperation(value.id, (signal) => copyMutation('sb.entity.copy.execute', value, signal)),
	)
	handle('commander:entity-rename-finish', finishEntityRenameSchema, (value) =>
		withOperation(value.id, (signal) => copyMutation('sb.entity.rename.finish', value, signal)),
	)
}
