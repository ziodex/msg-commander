import type { CommanderApi } from '@shared/contracts'

export const preferencesApi: Pick<CommanderApi, 'setInterfaceScale'> = {
	setInterfaceScale: (...args) => window.commander.setInterfaceScale(...args),
}
