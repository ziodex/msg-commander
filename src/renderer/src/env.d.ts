import type { CommanderApi } from '../../shared/contracts'
declare global {
	interface Window {
		commander: CommanderApi
	}
}
export {}
