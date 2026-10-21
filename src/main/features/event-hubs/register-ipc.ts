import { iotHubConnectSchema } from '../../../shared/iot-hub'
import {
	eventListenSchema,
	eventListenResultRequestSchema,
} from '../../../shared/contracts/event-hubs/listening'
import {
	eventExportSchema,
	eventSaveDraftsSchema,
	eventImportSchema,
	eventLoadImportSchema,
	eventDiscardImportSchema,
	eventCheckpointLoadSchema,
} from '../../../shared/contracts/event-hubs/files'
import {
	eventAdminGetSchema,
	eventPolicyListSchema,
	eventAdminChangeSchema,
	eventAdminResultSchema,
	eventPolicyKeyRequestSchema,
	eventPolicyCopyRequestSchema,
} from '../../../shared/contracts/event-hubs/administration'
import {
	eventHubSendSchema,
	eventHubSendResultRequestSchema,
} from '../../../shared/contracts/event-hubs/sending'

import { eventHubUrl } from './urls'
import {
	eventHubsConnectSchema,
	eventHubCopyUrlSchema,
	eventHubsRequestSchema,
	eventHubsListSchema,
	eventHubRequestSchema,
	eventHubPartitionRequestSchema,
	eventHubReadSchema,
	eventHubReadResultRequestSchema,
	eventInspectRequestSchema,
	eventBodyRequestSchema,
} from '../../../shared/contracts/event-hubs/core'

import { clipboard } from 'electron'

import { HostError } from '../../platform/backend'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerEventHubsIpc(
	context: Pick<MainIpcContext, 'backend' | 'eventFiles' | 'eventHubs' | 'workspace'>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:eh-listen', eventListenSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.listen', value, {
				signal,
				waitForCancellation: true,
				timeout: (value.maxSeconds + 90) * 1000,
			})
		}),
	)
	handle('commander:eh-listen-result', eventListenResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.listen.result', value, { signal })
		}),
	)
	handle('commander:eh-files-export', eventExportSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.export(value, signal)),
	)
	handle('commander:eh-files-drafts', eventSaveDraftsSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.saveDrafts(value, signal)),
	)
	handle('commander:eh-files-import', eventImportSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.import(value, signal)),
	)
	handle('commander:eh-files-load', eventLoadImportSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.load(value, signal)),
	)
	handle('commander:eh-files-discard', eventDiscardImportSchema, (value) =>
		context.eventFiles.discard(value),
	)
	handle('commander:eh-checkpoint-save', eventListenResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.saveCheckpoint(value, signal)),
	)
	handle('commander:eh-checkpoint-load', eventCheckpointLoadSchema, (value) =>
		withOperation(value.id, (signal) => context.eventFiles.loadCheckpoint(value, signal)),
	)
	handle('commander:eh-admin-context', eventHubsRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.admin.context', value, { signal })
		}),
	)
	handle('commander:eh-admin-get', eventAdminGetSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.admin.get', value, { signal })
		}),
	)
	handle('commander:eh-admin-policies', eventPolicyListSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.admin.policies', value, { signal })
		}),
	)
	handle('commander:eh-admin-result', eventAdminResultSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.admin.result', value, { signal })
		}),
	)
	handle('commander:eh-admin-key', eventPolicyKeyRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.admin.key', value, { signal })
		}),
	)
	handle('commander:eh-admin-copy', eventPolicyCopyRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.eventHubs.require(value.connectionId)
			const { format, ...request } = value
			const key = await context.backend.request('eh.admin.key', request, { signal })
			signal.throwIfAborted()
			context.eventHubs.require(value.connectionId)
			clipboard.writeText(key[format])
			return null
		}),
	)
	handle('commander:eh-admin-change', eventAdminChangeSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.eventHubs.require(value.connectionId)
			try {
				return await context.backend.request('eh.admin.change', value, {
					signal,
					waitForCancellation: true,
					timeout: 120000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Administration operation ${value.id} was interrupted. Check its retained receipt and Azure state before another change.`,
					)
				throw error
			}
		}),
	)
	handle('commander:eh-send', eventHubSendSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.eventHubs.require(value.connectionId)
			try {
				return await context.backend.request('eh.send', value, {
					signal,
					waitForCancellation: true,
					timeout: value.maxSeconds * 1000 + 60000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Event send ${value.id} was interrupted. Check its retained result before sending again; additional events may have been accepted.`,
					)
				throw error
			}
		}),
	)
	handle('commander:eh-send-result', eventHubSendResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.send.result', value, { signal })
		}),
	)
	handle('commander:eh-connect', eventHubsConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.eventHubs.connect(
				value,
				context.workspace.getForBackend(value.profileId),
				signal,
			),
		),
	)
	handle('commander:eh-disconnect', eventHubsRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.eventHubs.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:eh-list', eventHubsListSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.list', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:eh-copy-url', eventHubCopyUrlSchema, (value) =>
		withOperation(value.id, async (signal) => {
			const connection = context.eventHubs.require(value.connectionId)
			if (
				connection.service === 'iot-hub' &&
				value.target.kind !== 'namespace' &&
				value.target.hubName !== connection.initialHub?.name
			)
				throw new HostError(
					'INVALID_ARGUMENT',
					'The URL must match the IoT Hub built-in endpoint.',
				)
			signal.throwIfAborted()
			clipboard.writeText(eventHubUrl(connection.namespace, value))
			return null
		}),
	)
	handle('commander:eh-statistics', eventHubRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.statistics', value, { signal, timeout: 75000 })
		}),
	)
	handle('commander:eh-hub', eventHubRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.hub', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:eh-partition', eventHubPartitionRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.partition', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:eh-read', eventHubReadSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.read', value, {
				signal,
				timeout: value.maxSeconds * 1000 + 60000,
				waitForCancellation: true,
			})
		}),
	)
	handle('commander:eh-read-result', eventHubReadResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.read.result', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:eh-inspect', eventInspectRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.inspect', value, { signal })
		}),
	)
	handle('commander:eh-body', eventBodyRequestSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.eventHubs.require(value.connectionId)
			return context.backend.request('eh.body', value, { signal })
		}),
	)

	handle('commander:iot-connect', iotHubConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.eventHubs.connectIot(
				value,
				context.workspace.getForBackend(value.profileId),
				signal,
			),
		),
	)
}
