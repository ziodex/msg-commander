import { codecRequestSchema, codecResultRequestSchema } from '../../../shared/body-codecs'

import { z } from 'zod'

import { idSchema } from '../../../shared/contracts'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar, WithOperation } from '../../ipc/types'

export function registerBodyToolsIpc(
	context: Pick<MainIpcContext, 'bodyCodecs'>,
	handle: IpcRegistrar,
	withOperation: WithOperation,
) {
	handle('commander:body-codec', codecRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.bodyCodecs.convert(value, signal)),
	)
	handle('commander:body-codec-open', z.object({ id: idSchema }).strict(), (value) =>
		withOperation(value.id, (signal) => context.bodyCodecs.open(signal)),
	)
	handle('commander:body-codec-save', codecResultRequestSchema, (value) =>
		withOperation(value.id, (signal) => context.bodyCodecs.save(value.resultId, signal)),
	)
	handle('commander:body-codec-discard', idSchema, (value) => context.bodyCodecs.discard(value))
}
