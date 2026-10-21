import type { CommanderApi } from '@shared/contracts'

export const relayApi: Pick<
	CommanderApi,
	| 'applyRelayConfiguration'
	| 'changeRelayResource'
	| 'connectRelay'
	| 'copyRelayEndpoint'
	| 'copyRelayKey'
	| 'disconnectRelay'
	| 'exportRelayConfiguration'
	| 'getHybridResult'
	| 'getRelayConfigurationResult'
	| 'getRelayResource'
	| 'getRelayResult'
	| 'importRelayConfiguration'
	| 'listRelay'
	| 'resetHybrid'
	| 'revealRelayKey'
	| 'runHybrid'
> = {
	applyRelayConfiguration: (...args) => window.commander.applyRelayConfiguration(...args),
	changeRelayResource: (...args) => window.commander.changeRelayResource(...args),
	connectRelay: (...args) => window.commander.connectRelay(...args),
	copyRelayEndpoint: (...args) => window.commander.copyRelayEndpoint(...args),
	copyRelayKey: (...args) => window.commander.copyRelayKey(...args),
	disconnectRelay: (...args) => window.commander.disconnectRelay(...args),
	exportRelayConfiguration: (...args) => window.commander.exportRelayConfiguration(...args),
	getHybridResult: (...args) => window.commander.getHybridResult(...args),
	getRelayConfigurationResult: (...args) => window.commander.getRelayConfigurationResult(...args),
	getRelayResource: (...args) => window.commander.getRelayResource(...args),
	getRelayResult: (...args) => window.commander.getRelayResult(...args),
	importRelayConfiguration: (...args) => window.commander.importRelayConfiguration(...args),
	listRelay: (...args) => window.commander.listRelay(...args),
	resetHybrid: (...args) => window.commander.resetHybrid(...args),
	revealRelayKey: (...args) => window.commander.revealRelayKey(...args),
	runHybrid: (...args) => window.commander.runHybrid(...args),
}
