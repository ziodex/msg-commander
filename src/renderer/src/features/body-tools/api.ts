import type { CommanderApi } from '@shared/contracts'

export const bodyToolsApi: Pick<
	CommanderApi,
	'cancelOperation' | 'convertBody' | 'discardCodecBody' | 'openCodecBody' | 'saveCodecBody'
> = {
	cancelOperation: (...args) => window.commander.cancelOperation(...args),
	convertBody: (...args) => window.commander.convertBody(...args),
	discardCodecBody: (...args) => window.commander.discardCodecBody(...args),
	openCodecBody: (...args) => window.commander.openCodecBody(...args),
	saveCodecBody: (...args) => window.commander.saveCodecBody(...args),
}
