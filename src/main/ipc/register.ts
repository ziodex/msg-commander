import { registerTestJobIpc } from '../features/service-bus/test-jobs/register-ipc'

import { HostError } from '../platform/backend'

import type { MainIpcContext } from './context'
import type { IpcRegistrar } from './types'
import { registerRelayIpc } from '../features/relay/register-ipc'
import { registerEventGridIpc } from '../features/event-grid/register-ipc'
import { registerNotificationHubsIpc } from '../features/notification-hubs/register-ipc'
import { registerResourceConfigurationIpc } from '../features/resource-configuration/register-ipc'
import { registerWorkspaceIpc } from '../features/workspace/register-ipc'
import { registerServiceBusIpc } from '../features/service-bus/register-ipc'
import { registerEventHubsIpc } from '../features/event-hubs/register-ipc'
import { registerBodyToolsIpc } from '../features/body-tools/register-ipc'

export function registerApplicationIpc(context: MainIpcContext, handle: IpcRegistrar) {
	const withOperation = async <T>(id: string, action: (signal: AbortSignal) => Promise<T>) => {
		if (context.backend.status.state !== 'ready' || context.restarting)
			throw new HostError('BACKEND_UNAVAILABLE', 'Restart the backend before continuing.')
		if (context.operations.has(id) || context.operations.size >= 16)
			throw new HostError('BUSY', 'Too many active operations.')
		const controller = new AbortController()
		context.operations.set(id, controller)
		try {
			return await action(controller.signal)
		} finally {
			context.operations.delete(id)
		}
	}
	registerRelayIpc(context, handle, withOperation)
	registerEventGridIpc(context, handle, withOperation)
	registerNotificationHubsIpc(context, handle, withOperation)
	registerResourceConfigurationIpc(context, handle, withOperation)
	registerWorkspaceIpc(context, handle)
	registerServiceBusIpc(context, handle, withOperation)
	registerEventHubsIpc(context, handle, withOperation)
	registerBodyToolsIpc(context, handle, withOperation)
	registerTestJobIpc({
		handle,
		withOperation,
		backend: context.backend,
		serviceBus: context.serviceBus,
	})
}
