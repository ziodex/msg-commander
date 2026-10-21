import { z } from 'zod'
import { idSchema, type Profile, type Theme } from './profiles'
import { type BackendStatus } from './protocol'
import { type PreferenceState } from '../../application-settings'

export const operationSchema = z.discriminatedUnion('kind', [
	z.object({ id: idSchema, kind: z.literal('diagnostics') }).strict(),
	z.object({ id: idSchema, kind: z.literal('test-profile'), profileId: idSchema }).strict(),
])

export type Operation = z.infer<typeof operationSchema>

export type OperationResult = { summary: string }

export type Bootstrap = {
	version: string
	platform: string
	status: BackendStatus
	profiles: Profile[]
	theme: Theme
	preferenceState: PreferenceState
}

export type DesktopResult<T> =
	{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }
