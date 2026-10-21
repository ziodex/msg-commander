import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createWorkspaceBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'checkForUpdates'
	| 'setInterfaceScale'
	| 'exportOperationLog'
	| 'bootstrap'
	| 'saveProfile'
	| 'removeProfile'
	| 'runOperation'
	| 'cancelOperation'
	| 'restartBackend'
	| 'setTheme'
	| 'savePreferences'
	| 'openDeviceLogin'
> {
	return {
		checkForUpdates: () => invoke('commander:updates-check'),
		setInterfaceScale: (scale) => invoke('commander:interface-scale', scale),
		exportOperationLog: (request) => invoke('commander:operation-log', request),
		bootstrap: () => invoke('commander:bootstrap'),
		saveProfile: (profile) => invoke('commander:save-profile', profile),
		removeProfile: (id) => invoke('commander:remove-profile', id),
		runOperation: (operation) => invoke('commander:run', operation),
		cancelOperation: (id) => invoke('commander:cancel', id),
		restartBackend: () => invoke('commander:restart'),
		setTheme: (theme) => invoke('commander:theme', theme),
		savePreferences: (input) => invoke('commander:preferences', input),
		openDeviceLogin: () => invoke('commander:login'),
	}
}
