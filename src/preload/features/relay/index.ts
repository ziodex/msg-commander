import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createRelayBridge(
	invoke: PreloadInvoker,
): Pick<
	CommanderApi,
	| 'runHybrid'
	| 'getHybridResult'
	| 'resetHybrid'
	| 'exportRelayConfiguration'
	| 'importRelayConfiguration'
	| 'applyRelayConfiguration'
	| 'getRelayConfigurationResult'
	| 'connectRelay'
	| 'disconnectRelay'
	| 'listRelay'
	| 'getRelayResource'
	| 'changeRelayResource'
	| 'getRelayResult'
	| 'revealRelayKey'
	| 'copyRelayKey'
	| 'copyRelayEndpoint'
> {
	return {
		runHybrid: (request) => invoke('commander:hybrid-run', request),
		getHybridResult: (request) => invoke('commander:hybrid-result', request),
		resetHybrid: (request) => invoke('commander:hybrid-reset', request),
		exportRelayConfiguration: (request) => invoke('commander:relay-config-export', request),
		importRelayConfiguration: (request) => invoke('commander:relay-config-import', request),
		applyRelayConfiguration: (request) => invoke('commander:relay-config-apply', request),
		getRelayConfigurationResult: (request) => invoke('commander:relay-config-result', request),
		connectRelay: (request) => invoke('commander:relay-connect', request),
		disconnectRelay: (request) => invoke('commander:relay-disconnect', request),
		listRelay: (request) => invoke('commander:relay-list', request),
		getRelayResource: (request) => invoke('commander:relay-get', request),
		changeRelayResource: (request) => invoke('commander:relay-change', request),
		getRelayResult: (request) => invoke('commander:relay-result', request),
		revealRelayKey: (request) => invoke('commander:relay-key', request),
		copyRelayKey: (request) => invoke('commander:relay-copy-key', request),
		copyRelayEndpoint: (request) => invoke('commander:relay-copy-endpoint', request),
	}
}
