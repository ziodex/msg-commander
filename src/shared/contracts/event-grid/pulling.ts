import { z } from 'zod'
import { eventGridRequestSchema, eventGridTargetSchema } from './core'
const subscription = eventGridTargetSchema.refine(
	(v) => v.kind === 'subscription',
	'Choose a subscription.',
)
export const eventGridPullTargetSchema = eventGridRequestSchema.extend({ target: subscription })
export const eventGridReceiveSchema = eventGridPullTargetSchema.extend({
	maxEvents: z.number().int().min(1).max(100),
	batchSize: z.number().int().min(1).max(10),
	maxWaitSeconds: z.number().int().min(10).max(120),
	maxSeconds: z.number().int().min(1).max(300),
	acknowledged: z.literal(true),
})
export const eventGridSettlementActionSchema = z.enum([
	'acknowledge',
	'release',
	'reject',
	'renewLock',
])
export const eventGridSettleSchema = eventGridPullTargetSchema
	.extend({
		action: eventGridSettlementActionSchema,
		handles: z
			.array(z.string().uuid())
			.min(1)
			.max(100)
			.refine((v) => new Set(v).size === v.length),
		releaseDelaySeconds: z.union([
			z.literal(0),
			z.literal(10),
			z.literal(60),
			z.literal(600),
			z.literal(3600),
		]),
		acknowledged: z.literal(true),
	})
	.refine((v) => v.action === 'release' || v.releaseDelaySeconds === 0)
export const eventGridPullInspectSchema = eventGridPullTargetSchema.extend({
	handle: z.string().uuid(),
})
export const eventGridPullResultRequestSchema = eventGridRequestSchema.extend({
	operationId: z.string().uuid(),
})
export const eventGridReceivedSchema = z
	.object({
		handle: z.string().uuid(),
		target: subscription,
		eventId: z.string().max(257),
		source: z.string().max(257),
		eventType: z.string().max(257),
		subject: z.string().max(257),
		deliveryCount: z.number().int().positive(),
		receivedAt: z.string().max(64),
		estimatedLockedUntil: z.string().max(64),
		state: z.enum([
			'held',
			'expired',
			'lock-lost',
			'acknowledged',
			'released',
			'rejected',
			'unknown',
		]),
		bytes: z.number().int().min(1).max(1048576),
	})
	.strict()
export const eventGridReceivedListSchema = z.array(eventGridReceivedSchema).max(100)
export const eventGridEventInspectionSchema = z
	.object({
		item: eventGridReceivedSchema,
		eventJson: z.string().max(65536),
		truncated: z.boolean(),
	})
	.strict()
const counts = {
	requested: z.number().int().min(1).max(100),
	confirmed: z.number().int().min(0).max(100),
	failed: z.number().int().min(0).max(100),
	uncertain: z.number().int().min(0).max(100),
	elapsedMs: z.number().nonnegative(),
}
const action = z.enum(['receive', 'acknowledge', 'release', 'reject', 'renewLock'])
export const eventGridPullOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		target: subscription,
		action,
		...counts,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum(['count', 'time', 'empty', 'cancelled', 'error']),
		summary: z.string().max(2048),
		handles: z.array(z.string().uuid()).max(100),
		results: z
			.array(
				z
					.object({
						handle: z.string().uuid(),
						status: z.enum(['succeeded', 'failed', 'unknown', 'not-attempted']),
						errorCode: z.string().max(128).nullable(),
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
export const eventGridPullProgressSchema = z
	.object({
		type: z.literal('event-grid-pull-progress'),
		operationId: z.string().uuid(),
		action,
		...counts,
		phase: z.enum(['validating', 'receiving', 'settling', 'finished']),
	})
	.strict()
export type EventGridReceive = z.infer<typeof eventGridReceiveSchema>
export type EventGridSettle = z.infer<typeof eventGridSettleSchema>
export type EventGridPullTarget = z.infer<typeof eventGridPullTargetSchema>
export type EventGridPullInspect = z.infer<typeof eventGridPullInspectSchema>
export type EventGridPullResultRequest = z.infer<typeof eventGridPullResultRequestSchema>
export type EventGridReceived = z.infer<typeof eventGridReceivedSchema>
export type EventGridEventInspection = z.infer<typeof eventGridEventInspectionSchema>
export type EventGridPullOutcome = z.infer<typeof eventGridPullOutcomeSchema>
export type EventGridPullProgress = z.infer<typeof eventGridPullProgressSchema>
