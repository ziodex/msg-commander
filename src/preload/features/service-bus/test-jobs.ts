import type { CommanderApi } from '../../../shared/contracts'
import type { PreloadInvoker } from '../../types'

type TestJobBridge = Pick<CommanderApi, 'runTestJob' | 'previewTestPayload' | 'getTestJobResult'>

export function createTestJobBridge(invoke: PreloadInvoker): TestJobBridge {
	// Electron validates and wraps these responses in the existing CommanderApi contract.
	return {
		runTestJob: (request) => invoke('commander:sb-test-run', request),
		previewTestPayload: (request) => invoke('commander:test-payload-preview', request),
		getTestJobResult: (request) => invoke('commander:sb-test-result', request),
	}
}
