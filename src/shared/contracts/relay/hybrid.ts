import { z } from 'zod'
import { relayNameSchema } from './core'
const id = z.string().uuid()
export const hybridHeaderSchema = z
	.object({
		name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/),
		value: z
			.string()
			.max(1024)
			.regex(/^[\x20-\x7e]*$/),
	})
	.strict()
export function allowedHybridHeader(name: string) {
	return (
		!/^(authorization|proxy-authorization|servicebusauthorization|host|connection|upgrade|content-length|transfer-encoding|trailer|te|expect|cookie|set-cookie)$/i.test(
			name,
		) && !/^(sec-|sb-)/i.test(name)
	)
}
export const hybridRunSchema = z
	.object({
		id,
		profileId: id,
		name: relayNameSchema,
		mode: z.enum(['http-send', 'http-listen', 'stream-send', 'stream-listen']),
		method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
		body: z.string().max(22000),
		encoding: z.enum(['utf8', 'base64']),
		headers: z.array(hybridHeaderSchema).max(16),
		responseStatus: z.number().int().min(200).max(599),
		maxCount: z.number().int().min(1).max(100),
		maxSeconds: z.number().int().min(1).max(600),
		exchangeSeconds: z.number().int().min(1).max(60),
		acknowledged: z.literal(true),
	})
	.strict()
	.superRefine((v, ctx) => {
		const validBody =
			v.encoding === 'utf8'
				? new TextEncoder().encode(v.body).length <= 16384
				: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.body) &&
					(v.body.length / 4) * 3 -
						(v.body.endsWith('==') ? 2 : v.body.endsWith('=') ? 1 : 0) <=
						16384 &&
					btoa(atob(v.body)) === v.body
		if (
			!validBody ||
			v.headers.some((h) => !allowedHybridHeader(h.name)) ||
			new Set(v.headers.map((h) => h.name.toLowerCase())).size !== v.headers.length ||
			JSON.stringify(v.headers).length > 4096 ||
			(v.mode.startsWith('stream') && v.headers.length) ||
			(v.mode === 'http-send' && ['GET', 'HEAD'].includes(v.method) && v.body) ||
			(v.mode === 'http-listen' && [204, 304].includes(v.responseStatus) && v.body)
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Use a body up to 16 KiB and unique, permitted HTTP headers (4 KiB total). GET, HEAD, 204 and 304 have no configured body.',
			})
	})
export const hybridExchangeSchema = z
	.object({
		number: z.number().int().min(1).max(100),
		at: z.string().max(64),
		method: z.string().max(16),
		statusCode: z.number().int().min(100).max(599).nullable(),
		outcome: z.enum(['confirmed', 'rejected', 'unknown']),
		requestBody: z.string().max(21848),
		responseBody: z.string().max(21848),
		requestTruncated: z.boolean(),
		responseTruncated: z.boolean(),
		requestHeaders: z.array(hybridHeaderSchema).max(16),
		responseHeaders: z.array(hybridHeaderSchema).max(16),
		summary: z.string().max(512),
	})
	.strict()
export const hybridProgressSchema = z
	.object({
		type: z.literal('hybrid-progress'),
		operationId: id,
		count: z.number().int().min(0).max(100),
		maxCount: z.number().int().min(1).max(100),
		phase: z.enum([
			'connecting',
			'online',
			'reconnecting',
			'exchanging',
			'closing',
			'finished',
		]),
		elapsedMs: z.number().nonnegative(),
	})
	.strict()
export const hybridResultSchema = z
	.object({
		operationId: id,
		profileId: id,
		namespace: z.string().max(253),
		name: relayNameSchema,
		mode: hybridRunSchema.shape.mode,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum(['count', 'time', 'cancelled', 'buffer-limit', 'error']),
		exchanges: z.array(hybridExchangeSchema).max(100),
		elapsedMs: z.number().nonnegative(),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
	})
	.strict()
export const hybridResultRequestSchema = z.object({ id, profileId: id, operationId: id }).strict()
export type HybridRun = z.infer<typeof hybridRunSchema>
export type HybridExchange = z.infer<typeof hybridExchangeSchema>
export type HybridProgress = z.infer<typeof hybridProgressSchema>
export type HybridResult = z.infer<typeof hybridResultSchema>
export type HybridResultRequest = z.infer<typeof hybridResultRequestSchema>
