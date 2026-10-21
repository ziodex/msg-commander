import { z } from 'zod'
import { codecHostRequestSchema, codecHostResultSchema } from '../../body-codecs'

export type BodyToolsBackendParams = {
	'body.codec': z.infer<typeof codecHostRequestSchema>
}

export const bodyToolsBackendResults = {
	'body.codec': codecHostResultSchema,
}
