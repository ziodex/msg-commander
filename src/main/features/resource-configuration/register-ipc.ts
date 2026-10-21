import {
	messagingConfigApplySchema,
	messagingConfigResultRequestSchema,
} from '../../../shared/contracts/resource-configuration'
import { HostError } from '../../platform/backend'
import {
	messagingConfigRequestSchema,
	messagingConfigExportSchema,
} from '../../../shared/contracts/resource-configuration'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerResourceConfigurationIpc(
	context: Pick<MainIpcContext, 'backend' | 'messagingFiles' | 'requireMessaging'>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:messaging-config-import', messagingConfigRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.messagingFiles.import(value, signal)),
	)
	handle('commander:messaging-config-export', messagingConfigExportSchema, (value) =>
		withOperation(value.id, (signal) => context.messagingFiles.export(value, signal)),
	)

	handle('commander:messaging-config-apply', messagingConfigApplySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.requireMessaging(value.service, value.connectionId)
			try {
				return await context.backend.request(
					value.service === 'service-bus' ? 'sb.config.apply' : 'eh.config.apply',
					value,
					{ signal, timeout: 150000, waitForCancellation: true },
				)
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Configuration import ${value.id} was interrupted. Recover the retained result and inspect Azure state before another import. Nothing was retried.`,
					)
				throw error
			}
		}),
	)
	handle('commander:messaging-config-result', messagingConfigResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.requireMessaging(value.service, value.connectionId)
			return context.backend.request(
				value.service === 'service-bus' ? 'sb.config.result' : 'eh.config.result',
				value,
				{ signal },
			)
		}),
	)
}
