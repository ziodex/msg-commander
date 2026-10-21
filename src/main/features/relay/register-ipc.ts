import {
	relayConfigApplySchema,
	relayConfigExportSchema,
} from '../../../shared/contracts/relay/configuration'

import { hybridResultRequestSchema, hybridRunSchema } from '../../../shared/contracts/relay/hybrid'

import {
	relayChangeSchema,
	relayConnectSchema,
	relayCopyEndpointSchema,
	relayCopyKeySchema,
	relayGetSchema,
	relayKeySchema,
	relayListSchema,
	relayRequestSchema,
	relayResultSchema,
} from '../../../shared/contracts/relay/core'

import { clipboard } from 'electron'

import { z } from 'zod'
import { HostError } from '../../platform/backend'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerRelayIpc(
	context: Pick<MainIpcContext, 'backend' | 'hybrid' | 'relay' | 'relayFiles' | 'workspace'>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:hybrid-run', hybridRunSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.hybrid.run(value, context.workspace.getForBackend(value.profileId), signal),
		),
	)
	handle('commander:hybrid-result', hybridResultRequestSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.backend.request('hybrid.result', value, { signal }),
		),
	)
	handle('commander:hybrid-reset', z.object({ id: z.string().uuid() }).strict(), (value) =>
		withOperation(value.id, async () => {
			await context.hybrid.reset()
			return null
		}),
	)
	handle('commander:relay-config-export', relayConfigExportSchema, (value) =>
		withOperation(value.id, (signal) => context.relayFiles.export(value, signal)),
	)
	handle('commander:relay-config-import', relayRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.relayFiles.import(value, signal)),
	)
	handle('commander:relay-config-apply', relayConfigApplySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.relay.require(value.connectionId)
			try {
				return await context.backend.request('relay.config.apply', value, {
					signal,
					waitForCancellation: true,
					timeout: 150000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Relay import ${value.id} was interrupted. Check the retained receipt and Azure state before another change. Nothing was retried.`,
					)
				throw error
			}
		}),
	)
	handle('commander:relay-config-result', relayResultSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.relay.require(value.connectionId)
			return context.backend.request('relay.config.result', value, { signal })
		}),
	)
	handle('commander:relay-connect', relayConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.relay.connect(
				value,
				context.workspace.list().find((p) => p.id === value.profileId),
				signal,
			),
		),
	)
	handle('commander:relay-disconnect', relayRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.relay.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:relay-list', relayListSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.relay.require(value.connectionId)
			return context.backend.request('relay.list', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:relay-get', relayGetSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.relay.require(value.connectionId)
			return context.backend.request('relay.get', value, { signal, timeout: 60000 })
		}),
	)
	handle('commander:relay-result', relayResultSchema, (value) =>
		withOperation(value.id, (signal) => {
			context.relay.require(value.connectionId)
			return context.backend.request('relay.result', value, { signal })
		}),
	)
	handle('commander:relay-key', relayKeySchema, (value) =>
		withOperation(value.id, (signal) => {
			context.relay.require(value.connectionId)
			return context.backend.request('relay.key', value, { signal })
		}),
	)
	handle('commander:relay-copy-key', relayCopyKeySchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.relay.require(value.connectionId)
			const { format, ...request } = value
			const key = await context.backend.request('relay.key', request, { signal })
			signal.throwIfAborted()
			context.relay.require(value.connectionId)
			clipboard.writeText(key[format])
			return null
		}),
	)
	handle('commander:relay-copy-endpoint', relayCopyEndpointSchema, (value) =>
		withOperation(value.id, async () => {
			const connection = context.relay.require(value.connectionId)
			clipboard.writeText(
				`${value.scheme}://${connection.namespace}/${value.target.scope.name.split('/').map(encodeURIComponent).join('/')}`,
			)
			return null
		}),
	)
	handle('commander:relay-change', relayChangeSchema, (value) =>
		withOperation(value.id, async (signal) => {
			context.relay.require(value.connectionId)
			try {
				return await context.backend.request('relay.change', value, {
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
						`Relay operation ${value.id} was interrupted. Check its receipt and Azure state before another change.`,
					)
				throw error
			}
		}),
	)
}
