import { type ProfileInput } from './profiles'
import { healthSchema, resultSchema } from './protocol'

export type PlatformBackendParams = {
	'host.hello': { protocolVersion: number }
	'diagnostics.run': { operationId: string; durationMs: number }
	'auth.test': { operationId: string; profile: ProfileInput }
}

export const platformBackendResults = {
	'host.hello': healthSchema,
	'diagnostics.run': resultSchema,
	'auth.test': resultSchema,
}
