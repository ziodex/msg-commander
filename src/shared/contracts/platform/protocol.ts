import { z } from 'zod'

export const PROTOCOL_VERSION = 1

export const MAX_FRAME_BYTES = 1024 * 1024

export const MAX_PENDING = 16

export type BackendStatus = {
	state: 'starting' | 'ready' | 'stopped' | 'crashed'
	detail: string
	runtime?: string
}

export const healthSchema = z
	.object({
		protocolVersion: z.literal(PROTOCOL_VERSION),
		runtime: z.string(),
		version: z.string(),
	})
	.strict()

export const resultSchema = z.object({ summary: z.string().max(1024) }).strict()
