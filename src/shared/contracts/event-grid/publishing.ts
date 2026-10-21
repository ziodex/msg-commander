import { z } from 'zod'
import { eventGridRequestSchema, eventGridNameSchema } from './core'
const attribute = z
	.string()
	.max(4096)
	.refine(
		(v) =>
			!/[\u0000-\u001f\u007f-\u009f\ufdd0-\ufdef]/.test(v) &&
			![...v].some((c) => {
				const n = c.codePointAt(0)!
				return (n >= 0xd800 && n <= 0xdfff) || (n & 0xffff) >= 0xfffe
			}),
		'Use attributes without control characters.',
	)
const uri = attribute.refine(
	(v) =>
		!v || (/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$/.test(v) && !/%(?![a-f0-9]{2})/i.test(v)),
	'Enter a URI reference without spaces.',
)
export const cloudEventPropertySchema = z
	.object({
		name: z.string().regex(/^[a-z0-9]{1,20}$/),
		type: z.enum(['string', 'boolean', 'integer']),
		value: attribute,
	})
	.strict()
	.refine(
		(v) =>
			v.type === 'string' ||
			(v.type === 'boolean'
				? ['true', 'false'].includes(v.value)
				: /^-?(0|[1-9][0-9]*)$/.test(v.value) &&
					Number(v.value) >= -2147483648 &&
					Number(v.value) <= 2147483647),
		'Property value does not match its type.',
	)
const reserved = [
	'id',
	'source',
	'specversion',
	'type',
	'subject',
	'time',
	'datacontenttype',
	'dataschema',
	'data',
	'data_base64',
]
export const cloudEventDraftSchema = z
	.object({
		id: attribute.refine((v) => !!v.trim(), 'Enter an event ID.'),
		source: uri.refine((v) => !!v.trim(), 'Enter an event source.'),
		type: attribute.refine((v) => !!v.trim(), 'Enter an event type.'),
		subject: attribute,
		time: z.union([
			z.literal(''),
			z.iso.datetime({ offset: true }).refine((v) => !/\.[0-9]{8}/.test(v)),
		]),
		dataContentType: attribute,
		dataSchema: uri.refine(
			(v) => !v || /^[a-z][a-z0-9+.-]*:/i.test(v),
			'Schema must be an absolute URI.',
		),
		dataMode: z.enum(['json', 'text', 'base64', 'none']),
		data: z.string().max(262144),
		properties: z.array(cloudEventPropertySchema).max(32),
	})
	.strict()
	.superRefine((v, ctx) => {
		const names = v.properties.map((p) => p.name)
		if (new Set(names).size !== names.length || names.some((n) => reserved.includes(n)))
			ctx.addIssue({
				code: 'custom',
				message: 'Use unique extension names, excluding CloudEvents attributes.',
			})
		const mediaType = v.dataContentType.split(';')[0].trim().toLowerCase()
		if (v.dataContentType && !/^[^\s/;]+\/[^\s;]+(?:\s*;[^\r\n]*)?$/.test(v.dataContentType))
			ctx.addIssue({ code: 'custom', message: 'Enter a valid data content type.' })
		if (v.dataMode === 'json' && mediaType && !/\/(?:[^/]+\+)?json$/.test(mediaType)) {
			try {
				if (typeof JSON.parse(v.data) !== 'string')
					ctx.addIssue({
						code: 'custom',
						message:
							'Use a JSON content type for JSON values, or text mode for other formats.',
					})
			} catch {
				// JSON validation below reports syntax.
			}
		}
		if (v.dataMode === 'json') {
			try {
				JSON.parse(v.data)
			} catch {
				ctx.addIssue({ code: 'custom', message: 'Enter valid JSON event data.' })
			}
		}
		if (
			v.dataMode === 'base64' &&
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.data)
		)
			ctx.addIssue({ code: 'custom', message: 'Enter valid base64 event data.' })
		if (v.dataMode === 'none' && v.data !== '')
			ctx.addIssue({ code: 'custom', message: 'Clear data when omitting the payload.' })
	})
export const eventGridPublishSchema = eventGridRequestSchema
	.extend({
		topicName: eventGridNameSchema,
		mode: z.enum(['single', 'batch']),
		drafts: z.array(cloudEventDraftSchema).min(1).max(100),
		batchSize: z.number().int().min(1).max(100),
		maxSeconds: z.number().int().min(1).max(300),
		delayMs: z.number().int().min(0).max(1000),
		acknowledged: z.literal(true),
	})
	.superRefine((v, ctx) => {
		if (v.mode === 'single' && v.drafts.length !== 1)
			ctx.addIssue({
				code: 'custom',
				message: 'Single publishing requires exactly one event.',
			})
		if (new Set(v.drafts.map((d) => JSON.stringify([d.source, d.id]))).size !== v.drafts.length)
			ctx.addIssue({
				code: 'custom',
				message: 'Each event must have a unique source and ID pair.',
			})
		if (new TextEncoder().encode(JSON.stringify(v)).length > 524288)
			ctx.addIssue({ code: 'custom', message: 'Use at most 512 KiB per publish job.' })
	})
export const eventGridPublishResultRequestSchema = eventGridRequestSchema.extend({
	operationId: z.string().uuid(),
})
const counts = {
	totalEvents: z.number().int().min(1).max(100),
	confirmed: z.number().int().min(0).max(100),
	confirmedBatches: z.number().int().min(0).max(100),
	uncertain: z.number().int().min(0).max(100),
	elapsedMs: z.number().nonnegative(),
}
export const eventGridPublishOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		topicName: eventGridNameSchema,
		...counts,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum(['count', 'time', 'cancelled', 'error']),
		lastBatchFirstIndex: z.number().int().min(1).max(100).nullable(),
		lastBatchCount: z.number().int().min(0).max(100),
		summary: z.string().max(2048),
	})
	.strict()
export const eventGridPublishProgressSchema = z
	.object({
		type: z.literal('event-grid-publish-progress'),
		operationId: z.string().uuid(),
		...counts,
		phase: z.enum(['validating', 'sending', 'pacing', 'finished']),
	})
	.strict()
export type CloudEventDraft = z.infer<typeof cloudEventDraftSchema>
export type EventGridPublish = z.infer<typeof eventGridPublishSchema>
export type EventGridPublishOutcome = z.infer<typeof eventGridPublishOutcomeSchema>
export type EventGridPublishResultRequest = z.infer<typeof eventGridPublishResultRequestSchema>
export type EventGridPublishProgress = z.infer<typeof eventGridPublishProgressSchema>
// Keep data JSON as source text so large integers and decimal precision survive IPC and preview.
export function cloudEventJson(d: CloudEventDraft): string {
	const attrs: Record<string, unknown> = {
		specversion: '1.0',
		id: d.id,
		source: d.source,
		type: d.type,
	}
	for (const [name, value] of Object.entries({
		subject: d.subject,
		time: d.time,
		datacontenttype: d.dataContentType,
		dataschema: d.dataSchema,
	}))
		if (value) attrs[name] = value
	for (const p of d.properties)
		attrs[p.name] =
			p.type === 'boolean'
				? p.value === 'true'
				: p.type === 'integer'
					? Number(p.value)
					: p.value
	const head = JSON.stringify(attrs).slice(0, -1)
	return (
		head +
		(d.dataMode === 'none'
			? ''
			: ',"' +
				(d.dataMode === 'base64' ? 'data_base64' : 'data') +
				'":' +
				(d.dataMode === 'json' ? d.data : JSON.stringify(d.data))) +
		'}'
	)
}
export const newCloudEvent = (): CloudEventDraft => ({
	id: crypto.randomUUID(),
	source: '/msg-commander',
	type: 'Commander.Test',
	subject: '',
	time: new Date().toISOString(),
	dataContentType: 'application/json',
	dataSchema: '',
	dataMode: 'json',
	data: '{\n  "message": "Hello from Msg Commander"\n}',
	properties: [],
})
