import type { CommanderApi } from '@shared/contracts'

export const platformApi: Pick<
	CommanderApi,
	| 'bootstrap'
	| 'checkForUpdates'
	| 'cancelOperation'
	| 'exportOperationLog'
	| 'onEvent'
	| 'openDeviceLogin'
	| 'removeProfile'
	| 'restartBackend'
	| 'runOperation'
	| 'savePreferences'
	| 'saveProfile'
	| 'setTheme'
> = {
	bootstrap: (...args) => window.commander.bootstrap(...args),
	checkForUpdates: (...args) => window.commander.checkForUpdates(...args),
	cancelOperation: (...args) => window.commander.cancelOperation(...args),
	exportOperationLog: (...args) => window.commander.exportOperationLog(...args),
	onEvent: (...args) => window.commander.onEvent(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
	removeProfile: (...args) => window.commander.removeProfile(...args),
	restartBackend: (...args) => window.commander.restartBackend(...args),
	runOperation: (...args) => window.commander.runOperation(...args),
	savePreferences: (...args) => window.commander.savePreferences(...args),
	saveProfile: (...args) => window.commander.saveProfile(...args),
	setTheme: (...args) => window.commander.setTheme(...args),
}
