import {
	registrationFileExportSchema,
	registrationFileInspectSchema,
	registrationFileApplySchema,
} from '../../../shared/contracts/notification-hubs/registration-files'

import {
	nhConfigExportSchema,
	nhConfigApplySchema,
} from '../../../shared/contracts/notification-hubs/configuration'
import {
	credentialGetSchema,
	credentialImportSchema,
	credentialChangeSchema,
	credentialDiscardSchema,
} from '../../../shared/contracts/notification-hubs/credentials'

import {
	nhNotificationsConnectSchema,
	nhNotificationsRequestSchema,
	nhNotificationsResultSchema,
	notificationSendSchema,
} from '../../../shared/contracts/notification-hubs/notifications'

import {
	nhJobGetSchema,
	nhJobPreviewSchema,
	nhJobSubmitSchema,
	nhJobResultSchema,
} from '../../../shared/contracts/notification-hubs/jobs'
import {
	nhRegistrationChangeSchema,
	nhRegistrationResultSchema,
	nhRegistrationsConnectSchema,
	nhRegistrationsRequestSchema,
	nhRegistrationsQuerySchema,
	nhRegistrationInspectSchema,
} from '../../../shared/contracts/notification-hubs/registrations'

import {
	nhConnectSchema,
	nhRequestSchema,
	nhGetSchema,
	nhListSchema,
	nhChangeSchema,
	nhResultSchema,
	nhKeySchema,
	nhCopyKeySchema,
} from '../../../shared/contracts/notification-hubs/core'

import { clipboard } from 'electron'

import { HostError } from '../../platform/backend'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerNotificationHubsIpc(
	context: Pick<
		MainIpcContext,
		| 'backend'
		| 'credentialFiles'
		| 'nh'
		| 'nhFiles'
		| 'notifications'
		| 'registrationFiles'
		| 'registrations'
		| 'workspace'
	>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:nh-registration-files-export', registrationFileExportSchema, (value) =>
		withOperation(value.id, (signal) => context.registrationFiles.export(value, signal)),
	)
	handle('commander:nh-registration-files-import', nhRegistrationsRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.registrationFiles.import(value, signal)),
	)
	handle('commander:nh-registration-files-inspect', registrationFileInspectSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.files.inspect', value, {
				signal,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-registration-files-apply', registrationFileApplySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			try {
				const result = await context.backend.request(
					'nh.registrations.files.apply',
					value,
					{
						signal,
						waitForCancellation: true,
						timeout: 150000,
					},
				)
				context.registrations.require(value.connectionId)
				return result
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'CANCELLED', 'BACKEND_UNAVAILABLE', 'INVALID_REQUEST'].includes(
						error.code,
					)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						'Final registration import receipt unavailable. Check Azure state and the retained receipt before another write. Nothing was retried.',
					)
				throw error
			}
		}),
	)
	handle('commander:nh-registration-files-result', nhRegistrationResultSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.files.result', value, {
				signal,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-config-export', nhConfigExportSchema, (value) =>
		withOperation(value.id, (signal) => context.nhFiles.export(value, signal)),
	)
	handle('commander:nh-config-import', nhRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.nhFiles.import(value, signal)),
	)
	handle('commander:nh-config-apply', nhConfigApplySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			try {
				const result = await context.backend.request('nh.config.apply', value, {
					signal,
					waitForCancellation: true,
					timeout: 150000,
				})
				context.nh.require(value.connectionId)
				return result
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Notification Hubs import ${value.id} was interrupted. Check the retained receipt and Azure state before another change. Nothing was retried.`,
					)
				throw error
			}
		}),
	)
	handle('commander:nh-config-result', nhResultSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			const result = await context.backend.request('nh.config.result', value, { signal })
			context.nh.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-notifications-connect', nhNotificationsConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.notifications.connect(
				value,
				context.workspace.list().find((p) => p.id === value.profileId),
				signal,
			),
		),
	)
	handle('commander:nh-notifications-disconnect', nhNotificationsRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.notifications.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:nh-notifications-send', notificationSendSchema, (value) =>
		withOperation(value.id, (signal) => context.notifications.send(value, signal)),
	)
	handle('commander:nh-notifications-result', nhNotificationsResultSchema, (value) =>
		withOperation(value.id, (signal) => context.notifications.result(value, signal)),
	)
	handle('commander:nh-jobs-list', nhRegistrationsRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.jobs.list', value, {
				signal,
				timeout: 45000,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-jobs-get', nhJobGetSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.jobs.get', value, {
				signal,
				timeout: 45000,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-jobs-preview', nhJobPreviewSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.jobs.preview', value, {
				signal,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-jobs-discard', nhRegistrationsRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			return context.backend.request('nh.registrations.jobs.discard', value, { signal })
		}),
	)
	handle('commander:nh-jobs-submit', nhJobSubmitSchema, (value) =>
		withOperation(value.id, (signal) => context.registrations.submitJob(value, signal)),
	)
	handle('commander:nh-jobs-result', nhJobResultSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.jobs.result', value, {
				signal,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-registrations-get', nhRegistrationInspectSchema, (value) =>
		withOperation(value.id, (signal) => context.registrations.get(value, signal)),
	)
	handle('commander:nh-registrations-change', nhRegistrationChangeSchema, (value) =>
		withOperation(value.id, (signal) => context.registrations.change(value, signal)),
	)
	handle('commander:nh-registrations-result', nhRegistrationResultSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.registrations.require(value.connectionId)
			const result = await context.backend.request('nh.registrations.result', value, {
				signal,
			})
			context.registrations.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-registrations-connect', nhRegistrationsConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.registrations.connect(
				value,
				context.workspace.list().find((p) => p.id === value.profileId),
				signal,
			),
		),
	)
	handle('commander:nh-registrations-disconnect', nhRegistrationsRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.registrations.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:nh-registrations-query', nhRegistrationsQuerySchema, (value) =>
		withOperation(value.id, (signal) => context.registrations.query(value, signal)),
	)
	handle('commander:nh-registrations-inspect', nhRegistrationInspectSchema, (value) =>
		withOperation(value.id, (signal) => context.registrations.inspect(value, signal)),
	)
	handle('commander:nh-connect', nhConnectSchema, (value) =>
		withOperation(value.id, async (signal) => {
			await context.registrations.reset()
			await context.notifications.reset()
			return context.nh.connect(
				value,
				context.workspace.list().find((p) => p.id === value.profileId),
				signal,
			)
		}),
	)
	handle('commander:nh-disconnect', nhRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.registrations.reset()
			await context.notifications.reset()
			await context.nh.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:nh-list', nhListSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.nh.require(value.connectionId)
			return context.backend.request('nh.list', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:nh-credentials-get', credentialGetSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			const result = await context.backend.request('nh.credentials.get', value, {
				signal,
				timeout: 60000,
			})
			signal.throwIfAborted()
			context.nh.require(value.connectionId)
			return result
		}),
	)
	handle('commander:nh-credentials-import', credentialImportSchema, (value) =>
		withOperation(value.id, (signal) => context.credentialFiles.import(value, signal)),
	)
	handle('commander:nh-credentials-discard', credentialDiscardSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			await context.backend.request('nh.credentials.discard', value, { signal })
			context.nh.require(value.connectionId)
			return null
		}),
	)
	handle('commander:nh-credentials-change', credentialChangeSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			try {
				const result = await context.backend.request('nh.credentials.change', value, {
					signal,
					waitForCancellation: true,
					timeout: 120000,
				})
				context.nh.require(value.connectionId)
				return result
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						'Provider credential operation was interrupted. Check its receipt and Azure state before another change. Nothing was retried.',
					)
				throw error
			}
		}),
	)
	handle('commander:nh-get', nhGetSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.nh.require(value.connectionId)
			return context.backend.request('nh.get', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:nh-result', nhResultSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.nh.require(value.connectionId)
			return context.backend.request('nh.result', value, { signal })
		}),
	)
	handle('commander:nh-key', nhKeySchema, (value) =>
		withOperation(value.id, (signal) => {
			context.nh.require(value.connectionId)
			return context.backend.request('nh.key', value, { signal })
		}),
	)
	handle('commander:nh-copy-key', nhCopyKeySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			const { format, ...request } = value
			const key = await context.backend.request('nh.key', request, { signal })
			signal.throwIfAborted()
			context.nh.require(value.connectionId)
			clipboard.writeText(key[format])
			return null
		}),
	)
	handle('commander:nh-change', nhChangeSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.nh.require(value.connectionId)
			try {
				return await context.backend.request('nh.change', value, {
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
						`Notification Hubs operation ${value.id} was interrupted. Check its receipt and Azure state before another change.`,
					)
				throw error
			}
		}),
	)
}
