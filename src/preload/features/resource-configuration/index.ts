import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createResourceConfigurationBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'importMessagingConfiguration'
	| 'exportMessagingConfiguration'
	| 'applyMessagingConfiguration'
	| 'getMessagingConfigurationResult'
> {
	return {
		importMessagingConfiguration: (request) =>
			invoke('commander:messaging-config-import', request),
		exportMessagingConfiguration: (request) =>
			invoke('commander:messaging-config-export', request),
		applyMessagingConfiguration: (request) =>
			invoke('commander:messaging-config-apply', request),
		getMessagingConfigurationResult: (request) =>
			invoke('commander:messaging-config-result', request),
	}
}
