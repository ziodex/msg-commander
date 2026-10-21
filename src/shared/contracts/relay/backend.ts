import { z } from 'zod'
import { type ProfileInput } from '../platform/profiles'
import {
	type RelayConfigApply,
	type RelayConfigExport,
	relayConfigEncodedSchema,
	relayConfigPreviewSchema,
	relayConfigResultSchema,
} from './configuration'
import {
	type RelayChange,
	type RelayGet,
	type RelayKey,
	type RelayList,
	type RelayManagement,
	type RelayRequest,
	type RelayResult,
	relayConnectionSchema,
	relayDetailsSchema,
	relayKeyResultSchema,
	relayOutcomeSchema,
	relayPageSchema,
} from './core'
import { type HybridResultRequest, type HybridRun, hybridResultSchema } from './hybrid'

export type RelayBackendParams = {
	'hybrid.run': { request: HybridRun; profile: ProfileInput }
	'hybrid.result': HybridResultRequest
	'hybrid.reset': Record<string, never>
	'relay.config.export': RelayConfigExport
	'relay.config.preview': RelayRequest & { contentBase64: string }
	'relay.config.apply': RelayConfigApply
	'relay.config.result': RelayResult
	'relay.connect': { operationId: string; profile: ProfileInput; management: RelayManagement }
	'relay.reset': Record<string, never>
	'relay.disconnect': RelayRequest
	'relay.list': RelayList
	'relay.get': RelayGet
	'relay.change': RelayChange
	'relay.result': RelayResult
	'relay.key': RelayKey
}

export const relayBackendResults = {
	'hybrid.run': hybridResultSchema,
	'hybrid.result': hybridResultSchema.nullable(),
	'hybrid.reset': z.null(),
	'relay.config.export': relayConfigEncodedSchema,
	'relay.config.preview': relayConfigPreviewSchema,
	'relay.config.apply': relayConfigResultSchema,
	'relay.config.result': relayConfigResultSchema.nullable(),
	'relay.connect': relayConnectionSchema,
	'relay.reset': z.null(),
	'relay.disconnect': z.null(),
	'relay.list': relayPageSchema,
	'relay.get': relayDetailsSchema,
	'relay.change': relayOutcomeSchema,
	'relay.result': relayOutcomeSchema.nullable(),
	'relay.key': relayKeyResultSchema,
}
