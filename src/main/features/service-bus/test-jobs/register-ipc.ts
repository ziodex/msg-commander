import {
	testJobRequestSchema,
	testJobResultRequestSchema,
	testPayloadPreviewSchema,
} from '../../../../shared/contracts/service-bus/test-jobs'
import { HostError, type Backend } from '../../../platform/backend'
import type { ServiceBusController } from '../controller'
import type { IpcRegistrar, WithOperation } from '../../../ipc/types'

type Dependencies = {
	handle: IpcRegistrar
	withOperation: WithOperation
	serviceBus: Pick<ServiceBusController, 'require'>
	backend: Pick<Backend, 'request'>
}

export function registerTestJobIpc({ handle, withOperation, serviceBus, backend }: Dependencies) {
	handle('commander:test-payload-preview', testPayloadPreviewSchema, (value) =>
		withOperation(value.id, (signal) =>
			backend.request('test.payload.preview', value, { signal, timeout: 10000 }),
		),
	)
	handle('commander:sb-test-run', testJobRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			serviceBus.require(value.connectionId)
			try {
				return await backend.request('sb.test.run', value, {
					signal,
					waitForCancellation: true,
					timeout: value.maxSeconds * 1000 + 60000,
				})
			} catch (error) {
				if (
					!(error instanceof HostError) ||
					['TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(error.code)
				)
					throw new HostError(
						'OUTCOME_UNKNOWN',
						`Test job ${value.id} was interrupted. Progress counts are lower bounds; additional writes may have succeeded. Nothing was retried. Check its result before another run.`,
					)
				throw error
			}
		}),
	)
	handle('commander:sb-test-result', testJobResultRequestSchema, (value) =>
		withOperation(value.id, async (signal) => {
			serviceBus.require(value.connectionId)
			return await backend.request('sb.test.result', value, { signal, timeout: 60000 })
		}),
	)
}
