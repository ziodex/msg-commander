import { z } from 'zod'
import { eventOperationStatisticsSchema } from './statistics'
import { eventHubRequestSchema, eventHubsRequestSchema } from './core'
const base64 = z
	.string()
	.max(349528)
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
export const eventPropertySchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(128)
			.refine((v) => !!v.trim(), 'Enter a property name.'),
		type: z.enum([
			'string',
			'boolean',
			'int32',
			'int64',
			'uint64',
			'double',
			'guid',
			'datetime',
			'binary',
		]),
		value: z.string().max(4096),
	})
	.strict()
	.superRefine((v, ctx) => {
		let valid = true
		switch (v.type) {
			case 'boolean':
				valid = v.value === 'true' || v.value === 'false'
				break
			case 'int32':
			case 'int64':
			case 'uint64': {
				valid = (v.type === 'uint64' ? /^[0-9]+$/ : /^[+-]?[0-9]+$/).test(v.value)
				if (valid) {
					const n = BigInt(v.value)
					valid =
						v.type === 'int32'
							? n >= -2147483648n && n <= 2147483647n
							: v.type === 'int64'
								? n >= -9223372036854775808n && n <= 9223372036854775807n
								: n >= 0n && n <= 18446744073709551615n
				}
				break
			}
			case 'double':
				valid =
					/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(v.value) &&
					Number.isFinite(Number(v.value))
				break
			case 'guid':
				valid = z.string().uuid().safeParse(v.value).success
				break
			case 'datetime':
				valid =
					z.iso.datetime({ offset: true }).safeParse(v.value).success &&
					!/\.[0-9]{8}/.test(v.value)
				break
			case 'binary':
				valid = base64.safeParse(v.value).success
				break
		}
		if (!valid)
			ctx.addIssue({
				code: 'custom',
				message: 'Property value does not match its declared type.',
			})
	})
export const eventDraftSchema = z
	.object({
		bodyBase64: base64,
		contentType: z.string().max(128),
		correlationId: z.string().max(128),
		properties: z.array(eventPropertySchema).max(32),
	})
	.strict()
	.refine(
		(v) =>
			(v.bodyBase64.length * 3) / 4 -
				(v.bodyBase64.endsWith('==') ? 2 : v.bodyBase64.endsWith('=') ? 1 : 0) <=
			262144,
		'Use an event body up to 256 KiB.',
	)
	.refine(
		(v) => new Set(v.properties.map((p) => p.name)).size === v.properties.length,
		'Property names must be unique.',
	)
	.refine(
		(v) => new TextEncoder().encode(JSON.stringify(v.properties)).length <= 65536,
		'Use at most 64 KiB of properties.',
	)
export const eventRoutingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('automatic') }).strict(),
	z
		.object({
			kind: z.literal('partition'),
			value: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[0-9]+$/),
		})
		.strict(),
	z.object({ kind: z.literal('key'), value: z.string().min(1).max(128) }).strict(),
])
export const eventHubSendSchema = eventHubRequestSchema
	.extend({
		drafts: z.array(eventDraftSchema).min(1).max(20),
		routing: eventRoutingSchema,
		repetitions: z.number().int().min(1).max(1000),
		batchSize: z.number().int().min(1).max(100),
		maxSeconds: z.number().int().min(1).max(300),
		delayMs: z.number().int().min(0).max(1000),
		acknowledged: z.literal(true),
	})
	.refine((v) => v.drafts.length * v.repetitions <= 1000, 'Use at most 1,000 total events.')
	.refine(
		(v) => new TextEncoder().encode(JSON.stringify(v.drafts)).length <= 524288,
		'Use at most 512 KiB of serialized drafts.',
	)
export const eventHubSendResultRequestSchema = eventHubsRequestSchema.extend({
	operationId: z.string().uuid(),
})
const counts = {
	statistics: eventOperationStatisticsSchema.nullable().optional(),
	confirmed: z.number().int().min(0).max(1000),
	confirmedBatches: z.number().int().min(0).max(1000),
	uncertain: z.number().int().min(0).max(100),
	elapsedMs: z.number().nonnegative(),
}
export const eventHubSendResultSchema = z
	.object({
		operationId: z.string().uuid(),
		hubName: z.string().min(1).max(256),
		routing: eventRoutingSchema,
		draftCount: z.number().int().min(1).max(20),
		repetitions: z.number().int().min(1).max(1000),
		totalEvents: z.number().int().min(1).max(1000),
		batchSize: z.number().int().min(1).max(100),
		maxSeconds: z.number().int().min(1).max(300),
		delayMs: z.number().int().min(0).max(1000),
		...counts,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum(['count', 'time', 'cancelled', 'error']),
		lastBatchFirstIndex: z.number().int().min(1).max(1000).nullable(),
		lastBatchCount: z.number().int().min(0).max(100),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
	})
	.strict()
export const eventHubSendProgressSchema = z
	.object({
		type: z.literal('event-hub-send-progress'),
		operationId: z.string().uuid(),
		totalEvents: z.number().int().min(1).max(1000),
		...counts,
		phase: z.enum(['validating', 'sending', 'pacing', 'closing', 'finished']),
	})
	.strict()
export type EventDraft = z.infer<typeof eventDraftSchema>
export type EventRouting = z.infer<typeof eventRoutingSchema>
export type EventHubSend = z.infer<typeof eventHubSendSchema>
export type EventHubSendResult = z.infer<typeof eventHubSendResultSchema>
export type EventHubSendResultRequest = z.infer<typeof eventHubSendResultRequestSchema>
export type EventHubSendProgress = z.infer<typeof eventHubSendProgressSchema>
