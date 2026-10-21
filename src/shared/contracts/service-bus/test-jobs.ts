import { z } from 'zod'
import { entityTargetSchema } from '../../service-bus'
const id = z.string().uuid()
export const testGeneratorSchema = z
	.object({
		kind: z.enum(['literal', 'json-template', 'binary']),
		seed: z.number().int().min(0).max(2147483647),
		sizeBytes: z.number().int().min(1).max(65536),
	})
	.strict()
export const defaultTestGenerator = { kind: 'literal' as const, seed: 1, sizeBytes: 1024 }
export const testPayloadPreviewSchema = z
	.object({
		id,
		generator: testGeneratorSchema,
		body: z.string().max(65536),
		contentType: z.string().max(128),
		sampleIndex: z.number().int().min(1).max(100000),
	})
	.strict()
export const testPayloadResultSchema = z
	.object({
		contentBase64: z.string().max(349528),
		contentType: z.string().max(128),
		byteLength: z.number().int().min(0).max(262144),
		sampleIndex: z.number().int().min(1).max(100000),
	})
	.strict()
export type TestPayloadPreview = z.infer<typeof testPayloadPreviewSchema>
export type TestPayloadResult = z.infer<typeof testPayloadResultSchema>
export type TestGenerator = z.infer<typeof testGeneratorSchema>
export const testJobRequestSchema = z
	.object({
		id,
		connectionId: id,
		target: entityTargetSchema,
		mode: z.enum(['send', 'receive']),
		maxMessages: z.number().int().min(1).max(100000),
		maxSeconds: z.number().int().min(1).max(600),
		delayMs: z.number().int().min(0).max(1000),
		workers: z.number().int().min(1).max(8).default(1),
		batchSize: z.number().int().min(1).max(100).default(1),
		sessionId: z.string().max(128),
		body: z.string().max(65536),
		contentType: z.string().max(128),
		generator: testGeneratorSchema.default(defaultTestGenerator),
		settlement: z.enum(['complete', 'abandon', 'defer', 'dead-letter']).default('complete'),
		deadLetterReason: z.string().max(128).default(''),
		deadLetterDescription: z.string().max(1024).default(''),
		acknowledged: z.literal(true),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			(value.mode === 'send' && value.settlement !== 'complete') ||
			(value.mode === 'receive' && value.generator.kind !== 'literal')
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose a generator for sending or a settlement for receiving.',
			})
		if (value.settlement === 'defer' && value.maxMessages > 1000)
			ctx.addIssue({ code: 'custom', message: 'Defer tests are limited to 1,000 messages.' })
		if (
			value.settlement === 'dead-letter'
				? !value.deadLetterReason.trim()
				: !!(value.deadLetterReason || value.deadLetterDescription)
		)
			ctx.addIssue({ code: 'custom', message: 'Supply a reason only for dead-letter tests.' })
		if (
			value.mode === 'send' &&
			((value.generator.kind === 'binary' && value.body) ||
				(value.generator.kind !== 'literal' && value.contentType))
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Generated payloads use their own content type; binary payloads do not use a text body.',
			})
		if (value.mode === 'receive' && value.sessionId && value.workers !== 1)
			ctx.addIssue({
				code: 'custom',
				message: 'Use one receive worker for a selected session.',
			})
		if (
			(value.mode === 'send' && value.target.kind === 'subscription') ||
			(value.mode === 'receive' && value.target.kind === 'topic')
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Send to a queue or topic; receive from a queue or subscription.',
			})
		if (value.mode === 'receive' && (value.body || value.contentType))
			ctx.addIssue({
				code: 'custom',
				message: 'Receive jobs do not accept a message body or content type.',
			})
	})
export const testJobResultRequestSchema = z
	.object({ id, connectionId: id, operationId: id })
	.strict()
const counts = {
	sent: z.number().int().nonnegative(),
	received: z.number().int().nonnegative(),
	completed: z.number().int().nonnegative(),
	settled: z.number().int().nonnegative(),
	abandoned: z.number().int().nonnegative(),
	deferred: z.number().int().nonnegative(),
	deadLettered: z.number().int().nonnegative(),
	redelivered: z.number().int().nonnegative(),
	uncertain: z.number().int().min(0).max(800),
	elapsedMs: z.number().nonnegative(),
}
export const testJobProgressSchema = z
	.object({
		type: z.literal('test-job-progress'),
		operationId: id,
		mode: z.enum(['send', 'receive']),
		settlement: z.enum(['complete', 'abandon', 'defer', 'dead-letter']),
		maxMessages: z.number().int().min(1).max(100000),
		workers: z.number().int().min(1).max(8),
		batchSize: z.number().int().min(1).max(100),
		activeWorkers: z.number().int().min(0).max(8),
		sendBatches: z.number().int().nonnegative(),
		receiveCalls: z.number().int().nonnegative(),
		...counts,
		phase: z.enum([
			'opening',
			'sending',
			'receiving',
			'completing',
			'settling',
			'pacing',
			'closing',
			'finished',
		]),
	})
	.strict()
export const latencySummarySchema = z
	.object({
		samples: z.number().int().min(0).max(100000),
		minMs: z.number().nonnegative().nullable(),
		meanMs: z.number().nonnegative().nullable(),
		p50Ms: z.number().nonnegative().nullable(),
		p95Ms: z.number().nonnegative().nullable(),
		p99Ms: z.number().nonnegative().nullable(),
		maxMs: z.number().nonnegative().nullable(),
	})
	.strict()
export const testJobResultSchema = z
	.object({
		operationId: id,
		target: entityTargetSchema,
		mode: z.enum(['send', 'receive']),
		sessionId: z.string().max(128),
		maxMessages: z.number().int().min(1).max(100000),
		maxSeconds: z.number().int().min(1).max(600),
		delayMs: z.number().int().min(0).max(1000),
		generator: testGeneratorSchema,
		settlement: z.enum(['complete', 'abandon', 'defer', 'dead-letter']),
		deferredSequenceNumbers: z.array(z.string().regex(/^\d+$/)).max(1000),
		referenceWarning: z.string().max(1024).nullable(),
		workers: z.number().int().min(1).max(8),
		batchSize: z.number().int().min(1).max(100),
		sendBatches: z.number().int().nonnegative(),
		receiveCalls: z.number().int().nonnegative(),
		latency: z
			.object({
				send: latencySummarySchema,
				receive: latencySummarySchema,
				complete: latencySummarySchema,
				settle: latencySummarySchema,
			})
			.strict(),
		workerResults: z
			.array(
				z
					.object({
						worker: z.number().int().min(1).max(8),
						...counts,
						sendBatches: z.number().int().nonnegative(),
						receiveCalls: z.number().int().nonnegative(),
						uncertainMessageIds: z.array(z.string().max(128)).max(100),
						uncertainSequenceNumber: z.string().regex(/^\d+$/).nullable(),
					})
					.strict(),
			)
			.max(8),
		...counts,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum(['message-limit', 'time-limit', 'cancelled', 'error', 'redelivery']),
		lastMessageId: z.string().max(128).nullable(),
		lastSequenceNumber: z.string().regex(/^\d+$/).nullable(),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
	})
	.strict()
export type TestJobRequest = z.infer<typeof testJobRequestSchema>
export type TestJobResultRequest = z.infer<typeof testJobResultRequestSchema>
export type TestJobResult = z.infer<typeof testJobResultSchema>
export type TestJobProgress = z.infer<typeof testJobProgressSchema>
