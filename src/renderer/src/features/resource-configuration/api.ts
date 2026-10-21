import type { CommanderApi } from '@shared/contracts'

export const resourceConfigurationApi: Pick<
	CommanderApi,
	| 'applyMessagingConfiguration'
	| 'exportMessagingConfiguration'
	| 'getMessagingConfigurationResult'
	| 'importMessagingConfiguration'
	| 'openDeviceLogin'
> = {
	applyMessagingConfiguration: (...args) => window.commander.applyMessagingConfiguration(...args),
	exportMessagingConfiguration: (...args) =>
		window.commander.exportMessagingConfiguration(...args),
	getMessagingConfigurationResult: (...args) =>
		window.commander.getMessagingConfigurationResult(...args),
	importMessagingConfiguration: (...args) =>
		window.commander.importMessagingConfiguration(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
}
