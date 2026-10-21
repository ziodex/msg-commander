import {
	eventGridReceiveSchema,
	eventGridSettleSchema,
	eventGridPullTargetSchema,
	eventGridPullInspectSchema,
	eventGridPullResultRequestSchema,
} from '../../../shared/contracts/event-grid/pulling'
import {
	eventGridPublishSchema,
	eventGridPublishResultRequestSchema,
} from '../../../shared/contracts/event-grid/publishing'
import {
	eventGridAdminReadSchema,
	eventGridAdminChangeSchema,
	eventGridAdminResultSchema,
} from '../../../shared/contracts/event-grid/administration'

import {
	eventGridConnectSchema,
	eventGridRequestSchema,
	eventGridListSchema,
	eventGridGetSchema,
} from '../../../shared/contracts/event-grid/core'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerEventGridIpc(
	context: Pick<MainIpcContext, 'grid' | 'workspace'>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:eg-pull-receive', eventGridReceiveSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.receive(value, signal)),
	)
	handle('commander:eg-pull-settle', eventGridSettleSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.settle(value, signal)),
	)
	handle('commander:eg-pull-list', eventGridPullTargetSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.received(value, signal)),
	)
	handle('commander:eg-pull-clear', eventGridPullTargetSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.clearReceived(value, signal)),
	)
	handle('commander:eg-pull-inspect', eventGridPullInspectSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.inspectReceived(value, signal)),
	)
	handle('commander:eg-pull-result', eventGridPullResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.pullResult(value, signal)),
	)
	handle('commander:eg-publish', eventGridPublishSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.publish(value, signal)),
	)
	handle('commander:eg-publish-result', eventGridPublishResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.publishResult(value, signal)),
	)
	handle('commander:eg-connect', eventGridConnectSchema, (value) =>
		withOperation(value.id, (signal) =>
			context.grid.connect(
				value,
				context.workspace.list().find((p) => p.id === value.profileId),
				signal,
			),
		),
	)
	handle('commander:eg-disconnect', eventGridRequestSchema, (value) =>
		withOperation(value.id, async () => {
			await context.grid.disconnect(value.connectionId)
			return null
		}),
	)
	handle('commander:eg-list', eventGridListSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.list(value, signal)),
	)
	handle('commander:eg-admin-get', eventGridAdminReadSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.adminGet(value, signal)),
	)
	handle('commander:eg-admin-change', eventGridAdminChangeSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.change(value, signal)),
	)
	handle('commander:eg-admin-result', eventGridAdminResultSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.result(value, signal)),
	)
	handle('commander:eg-get', eventGridGetSchema, (value) =>
		withOperation(value.id, (signal) => context.grid.get(value, signal)),
	)
}
