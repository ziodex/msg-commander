import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createNotificationHubsBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'listNotificationHubJobs'
	| 'getNotificationHubJob'
	| 'previewNotificationHubJob'
	| 'discardNotificationHubJob'
	| 'submitNotificationHubJob'
	| 'getNotificationHubJobResult'
	| 'connectNotificationSender'
	| 'disconnectNotificationSender'
	| 'sendTestNotification'
	| 'getTestNotificationResult'
	| 'getNotificationHubRegistration'
	| 'changeNotificationHubRegistration'
	| 'getNotificationHubRegistrationResult'
	| 'connectNotificationHubRegistrations'
	| 'disconnectNotificationHubRegistrations'
	| 'queryNotificationHubRegistrations'
	| 'inspectNotificationHubRegistration'
	| 'exportNotificationHubRegistrations'
	| 'importNotificationHubRegistrations'
	| 'inspectNotificationHubRegistrationImport'
	| 'applyNotificationHubRegistrationImport'
	| 'getNotificationHubRegistrationImportResult'
	| 'exportNotificationHubConfiguration'
	| 'importNotificationHubConfiguration'
	| 'applyNotificationHubConfiguration'
	| 'getNotificationHubConfigurationResult'
	| 'connectNotificationHub'
	| 'disconnectNotificationHub'
	| 'listNotificationHub'
	| 'getNotificationHubCredentials'
	| 'importNotificationHubCredential'
	| 'discardNotificationHubCredential'
	| 'changeNotificationHubCredentials'
	| 'getNotificationHubResource'
	| 'changeNotificationHubResource'
	| 'getNotificationHubResult'
	| 'revealNotificationHubKey'
	| 'copyNotificationHubKey'
> {
	return {
		listNotificationHubJobs: (request) => invoke('commander:nh-jobs-list', request),
		getNotificationHubJob: (request) => invoke('commander:nh-jobs-get', request),
		previewNotificationHubJob: (request) => invoke('commander:nh-jobs-preview', request),
		discardNotificationHubJob: (request) => invoke('commander:nh-jobs-discard', request),
		submitNotificationHubJob: (request) => invoke('commander:nh-jobs-submit', request),
		getNotificationHubJobResult: (request) => invoke('commander:nh-jobs-result', request),
		connectNotificationSender: (request) =>
			invoke('commander:nh-notifications-connect', request),
		disconnectNotificationSender: (request) =>
			invoke('commander:nh-notifications-disconnect', request),
		sendTestNotification: (request) => invoke('commander:nh-notifications-send', request),
		getTestNotificationResult: (request) =>
			invoke('commander:nh-notifications-result', request),
		getNotificationHubRegistration: (request) =>
			invoke('commander:nh-registrations-get', request),
		changeNotificationHubRegistration: (request) =>
			invoke('commander:nh-registrations-change', request),
		getNotificationHubRegistrationResult: (request) =>
			invoke('commander:nh-registrations-result', request),
		connectNotificationHubRegistrations: (request) =>
			invoke('commander:nh-registrations-connect', request),
		disconnectNotificationHubRegistrations: (request) =>
			invoke('commander:nh-registrations-disconnect', request),
		queryNotificationHubRegistrations: (request) =>
			invoke('commander:nh-registrations-query', request),
		inspectNotificationHubRegistration: (request) =>
			invoke('commander:nh-registrations-inspect', request),
		exportNotificationHubRegistrations: (request) =>
			invoke('commander:nh-registration-files-export', request),
		importNotificationHubRegistrations: (request) =>
			invoke('commander:nh-registration-files-import', request),
		inspectNotificationHubRegistrationImport: (request) =>
			invoke('commander:nh-registration-files-inspect', request),
		applyNotificationHubRegistrationImport: (request) =>
			invoke('commander:nh-registration-files-apply', request),
		getNotificationHubRegistrationImportResult: (request) =>
			invoke('commander:nh-registration-files-result', request),
		exportNotificationHubConfiguration: (request) =>
			invoke('commander:nh-config-export', request),
		importNotificationHubConfiguration: (request) =>
			invoke('commander:nh-config-import', request),
		applyNotificationHubConfiguration: (request) =>
			invoke('commander:nh-config-apply', request),
		getNotificationHubConfigurationResult: (request) =>
			invoke('commander:nh-config-result', request),
		connectNotificationHub: (request) => invoke('commander:nh-connect', request),
		disconnectNotificationHub: (request) => invoke('commander:nh-disconnect', request),
		listNotificationHub: (request) => invoke('commander:nh-list', request),
		getNotificationHubCredentials: (request) => invoke('commander:nh-credentials-get', request),
		importNotificationHubCredential: (request) =>
			invoke('commander:nh-credentials-import', request),
		discardNotificationHubCredential: (request) =>
			invoke('commander:nh-credentials-discard', request),
		changeNotificationHubCredentials: (request) =>
			invoke('commander:nh-credentials-change', request),
		getNotificationHubResource: (request) => invoke('commander:nh-get', request),
		changeNotificationHubResource: (request) => invoke('commander:nh-change', request),
		getNotificationHubResult: (request) => invoke('commander:nh-result', request),
		revealNotificationHubKey: (request) => invoke('commander:nh-key', request),
		copyNotificationHubKey: (request) => invoke('commander:nh-copy-key', request),
	}
}
