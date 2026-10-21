import type { CommanderApi } from '@shared/contracts'

export const notificationHubsApi: Pick<
	CommanderApi,
	| 'applyNotificationHubConfiguration'
	| 'applyNotificationHubRegistrationImport'
	| 'changeNotificationHubCredentials'
	| 'changeNotificationHubRegistration'
	| 'changeNotificationHubResource'
	| 'connectNotificationHub'
	| 'connectNotificationHubRegistrations'
	| 'connectNotificationSender'
	| 'copyNotificationHubKey'
	| 'discardNotificationHubJob'
	| 'discardNotificationHubCredential'
	| 'disconnectNotificationHub'
	| 'disconnectNotificationHubRegistrations'
	| 'disconnectNotificationSender'
	| 'exportNotificationHubConfiguration'
	| 'exportNotificationHubRegistrations'
	| 'getNotificationHubConfigurationResult'
	| 'getNotificationHubCredentials'
	| 'getNotificationHubJob'
	| 'getNotificationHubJobResult'
	| 'getNotificationHubRegistration'
	| 'getNotificationHubRegistrationImportResult'
	| 'getNotificationHubRegistrationResult'
	| 'getNotificationHubResource'
	| 'getNotificationHubResult'
	| 'getTestNotificationResult'
	| 'importNotificationHubConfiguration'
	| 'importNotificationHubCredential'
	| 'importNotificationHubRegistrations'
	| 'inspectNotificationHubRegistration'
	| 'inspectNotificationHubRegistrationImport'
	| 'listNotificationHub'
	| 'listNotificationHubJobs'
	| 'openDeviceLogin'
	| 'previewNotificationHubJob'
	| 'queryNotificationHubRegistrations'
	| 'revealNotificationHubKey'
	| 'sendTestNotification'
	| 'submitNotificationHubJob'
> = {
	discardNotificationHubCredential: (...args) =>
		window.commander.discardNotificationHubCredential(...args),
	applyNotificationHubConfiguration: (...args) =>
		window.commander.applyNotificationHubConfiguration(...args),
	applyNotificationHubRegistrationImport: (...args) =>
		window.commander.applyNotificationHubRegistrationImport(...args),
	changeNotificationHubCredentials: (...args) =>
		window.commander.changeNotificationHubCredentials(...args),
	changeNotificationHubRegistration: (...args) =>
		window.commander.changeNotificationHubRegistration(...args),
	changeNotificationHubResource: (...args) =>
		window.commander.changeNotificationHubResource(...args),
	connectNotificationHub: (...args) => window.commander.connectNotificationHub(...args),
	connectNotificationHubRegistrations: (...args) =>
		window.commander.connectNotificationHubRegistrations(...args),
	connectNotificationSender: (...args) => window.commander.connectNotificationSender(...args),
	copyNotificationHubKey: (...args) => window.commander.copyNotificationHubKey(...args),
	discardNotificationHubJob: (...args) => window.commander.discardNotificationHubJob(...args),
	disconnectNotificationHub: (...args) => window.commander.disconnectNotificationHub(...args),
	disconnectNotificationHubRegistrations: (...args) =>
		window.commander.disconnectNotificationHubRegistrations(...args),
	disconnectNotificationSender: (...args) =>
		window.commander.disconnectNotificationSender(...args),
	exportNotificationHubConfiguration: (...args) =>
		window.commander.exportNotificationHubConfiguration(...args),
	exportNotificationHubRegistrations: (...args) =>
		window.commander.exportNotificationHubRegistrations(...args),
	getNotificationHubConfigurationResult: (...args) =>
		window.commander.getNotificationHubConfigurationResult(...args),
	getNotificationHubCredentials: (...args) =>
		window.commander.getNotificationHubCredentials(...args),
	getNotificationHubJob: (...args) => window.commander.getNotificationHubJob(...args),
	getNotificationHubJobResult: (...args) => window.commander.getNotificationHubJobResult(...args),
	getNotificationHubRegistration: (...args) =>
		window.commander.getNotificationHubRegistration(...args),
	getNotificationHubRegistrationImportResult: (...args) =>
		window.commander.getNotificationHubRegistrationImportResult(...args),
	getNotificationHubRegistrationResult: (...args) =>
		window.commander.getNotificationHubRegistrationResult(...args),
	getNotificationHubResource: (...args) => window.commander.getNotificationHubResource(...args),
	getNotificationHubResult: (...args) => window.commander.getNotificationHubResult(...args),
	getTestNotificationResult: (...args) => window.commander.getTestNotificationResult(...args),
	importNotificationHubConfiguration: (...args) =>
		window.commander.importNotificationHubConfiguration(...args),
	importNotificationHubCredential: (...args) =>
		window.commander.importNotificationHubCredential(...args),
	importNotificationHubRegistrations: (...args) =>
		window.commander.importNotificationHubRegistrations(...args),
	inspectNotificationHubRegistration: (...args) =>
		window.commander.inspectNotificationHubRegistration(...args),
	inspectNotificationHubRegistrationImport: (...args) =>
		window.commander.inspectNotificationHubRegistrationImport(...args),
	listNotificationHub: (...args) => window.commander.listNotificationHub(...args),
	listNotificationHubJobs: (...args) => window.commander.listNotificationHubJobs(...args),
	openDeviceLogin: (...args) => window.commander.openDeviceLogin(...args),
	previewNotificationHubJob: (...args) => window.commander.previewNotificationHubJob(...args),
	queryNotificationHubRegistrations: (...args) =>
		window.commander.queryNotificationHubRegistrations(...args),
	revealNotificationHubKey: (...args) => window.commander.revealNotificationHubKey(...args),
	sendTestNotification: (...args) => window.commander.sendTestNotification(...args),
	submitNotificationHubJob: (...args) => window.commander.submitNotificationHubJob(...args),
}
