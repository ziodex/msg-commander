import { contextBridge, ipcRenderer } from 'electron'
import type { AppEvent, CommanderApi } from '../shared/contracts'
import type { PreloadInvoker } from './types'
import { createTestJobBridge } from './features/service-bus/test-jobs'
import { createWorkspaceBridge } from './features/workspace'
import { createNotificationHubsBridge } from './features/notification-hubs'
import { createEventGridBridge } from './features/event-grid'
import { createRelayBridge } from './features/relay'
import { createEventHubsBridge } from './features/event-hubs'
import { createResourceConfigurationBridge } from './features/resource-configuration'
import { createServiceBusBridge } from './features/service-bus'
import { createBodyToolsBridge } from './features/body-tools'

const invoke: PreloadInvoker = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
const api: CommanderApi = {
	...createWorkspaceBridge(invoke),
	...createNotificationHubsBridge(invoke),
	...createEventGridBridge(invoke),
	...createRelayBridge(invoke),
	...createEventHubsBridge(invoke),
	...createResourceConfigurationBridge(invoke),
	...createServiceBusBridge(invoke),
	...createBodyToolsBridge(invoke),
	...createTestJobBridge(invoke),
	onEvent: (callback) => {
		const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) => callback(data)
		ipcRenderer.on('commander:event', listener)
		return () => ipcRenderer.removeListener('commander:event', listener)
	},
}
contextBridge.exposeInMainWorld('commander', api)
