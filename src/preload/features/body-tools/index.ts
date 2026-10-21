import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

export function createBodyToolsBridge(
	invoke: PreloadInvoker,
): Pick<CommanderApi, 'convertBody' | 'openCodecBody' | 'saveCodecBody' | 'discardCodecBody'> {
	return {
		convertBody: (input) => invoke('commander:body-codec', input),
		openCodecBody: (input) => invoke('commander:body-codec-open', input),
		saveCodecBody: (input) => invoke('commander:body-codec-save', input),
		discardCodecBody: (resultId) => invoke('commander:body-codec-discard', resultId),
	}
}
