import { z } from 'zod'
export const CODEC_LIMIT = 262144
const base64 = z
	.string()
	.max(349528)
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
export const codecOptionsSchema = z
	.object({
		direction: z.enum(['decode', 'encode']),
		format: z.enum(['bytes', 'text']),
		encoding: z.enum(['utf8', 'ascii', 'utf16le', 'utf16be', 'utf32le', 'utf32be']),
		compression: z.enum(['none', 'gzip', 'deflate']),
		bom: z.boolean(),
	})
	.strict()
export const codecRequestSchema = codecOptionsSchema.extend({ id: z.uuid(), contentBase64: base64 })
export const codecHostRequestSchema = codecOptionsSchema
	.omit({ compression: true })
	.extend({ contentBase64: base64 })
export const codecHostResultSchema = z
	.object({
		contentBase64: base64,
		kind: z.enum(['text', 'bytes']),
		warnings: z.array(z.string().max(512)).max(8),
	})
	.strict()
export const codecResultSchema = codecHostResultSchema.extend({
	resultId: z.uuid(),
	byteLength: z.number().int().min(0).max(CODEC_LIMIT),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const codecResultRequestSchema = z.object({ id: z.uuid(), resultId: z.uuid() }).strict()
export type CodecOptions = z.infer<typeof codecOptionsSchema>
export type CodecRequest = z.infer<typeof codecRequestSchema>
export type CodecResult = z.infer<typeof codecResultSchema>
export type CodecHostResult = z.infer<typeof codecHostResultSchema>
export const codecFormats: Record<CodecOptions['format'], string> = {
	bytes: 'Original bytes (compression only)',
	text: 'Text encoding',
}
