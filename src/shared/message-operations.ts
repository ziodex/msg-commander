import { subQueueSchema } from './service-bus'
import { sessionLeaseSchema } from './sessions'
import { z } from 'zod'
import {
	entityTargetSchema,
	peekTargetSchema,
	messageSummarySchema,
	sequenceSchema,
} from './service-bus'
const id = z.string().uuid()
const base = z.object({ id, connectionId: id }).strict()
export const sendTargetSchema = z.union([
	entityTargetSchema.options[0],
	entityTargetSchema.options[1],
])
export const draftPropertySchema = z
	.object({
		name: z.string().min(1).max(128),
		type: z.enum([
			'string',
			'boolean',
			'int32',
			'int64',
			'uint64',
			'double',
			'decimal',
			'guid',
			'datetime',
			'timespan',
		]),
		value: z.string().max(4096),
	})
	.strict()
export const draftSchema = z
	.object({
		bodyBase64: z
			.string()
			.max(349528)
			.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
		messageId: z.string().min(1).max(128),
		subject: z.string().max(128),
		contentType: z.string().max(128),
		correlationId: z.string().max(128),
		sessionId: z.string().max(128),
		replyTo: z.string().max(260),
		replyToSessionId: z.string().max(128),
		to: z.string().max(260),
		partitionKey: z.string().max(128),
		ttlSeconds: z.number().int().min(1).max(31536000).nullable(),
		ttlDuration: z.string().min(1).max(64).optional(),
		properties: z.array(draftPropertySchema).max(32),
	})
	.strict()
	.refine(
		(value) => !value.ttlDuration || value.ttlSeconds === null,
		'Choose a TTL duration or seconds, not both.',
	)
	.refine(
		(value) => new Set(value.properties.map((p) => p.name)).size === value.properties.length,
		'Property names must be unique.',
	)
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value.properties)).length <= 65536,
		'Use at most 64 KiB of property metadata.',
	)
export const sendRequestSchema = base.extend({ target: sendTargetSchema, draft: draftSchema })
export const batchRequestSchema = base
	.extend({
		target: sendTargetSchema,
		drafts: z.array(draftSchema).min(1).max(20),
		scheduledEnqueueTime: z.iso.datetime({ offset: true }).nullable(),
	})
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value.drafts)).length <= 524288,
		'Use at most 512 KiB of serialized drafts per batch.',
	)
	.refine(
		(value) =>
			new Set(value.drafts.map((draft) => draft.messageId)).size === value.drafts.length,
		'Message IDs must be unique within a batch.',
	)
export const scheduledRequestSchema = base.extend({
	target: sendTargetSchema,
	fromSequenceNumber: sequenceSchema,
	maxMessages: z.number().int().min(1).max(25),
})
export const cancelScheduledRequestSchema = base.extend({
	target: sendTargetSchema,
	sequenceNumbers: z
		.array(sequenceSchema)
		.min(1)
		.max(20)
		.refine(
			(values) => new Set(values).size === values.length,
			'Sequence numbers must be unique.',
		),
	confirmation: z.string().min(1).max(270),
})
export type BatchRequest = z.infer<typeof batchRequestSchema>
export type ScheduledRequest = z.infer<typeof scheduledRequestSchema>
export type CancelScheduledRequest = z.infer<typeof cancelScheduledRequestSchema>
export const receiveRequestSchema = base.extend({
	target: peekTargetSchema,
	subQueue: subQueueSchema,
	sessionId: z.string().max(128),
	maxMessages: z.number().int().min(1).max(10),
	waitSeconds: z.number().int().min(1).max(20),
	deferredSequence: sequenceSchema.optional(),
	sessionLeaseId: id.optional(),
})
export const deliveriesRequestSchema = base
export const settleRequestSchema = base.extend({
	deliveryId: id,
	action: z.enum(['complete', 'abandon', 'dead-letter', 'defer', 'renew']),
	reason: z.string().max(128),
	description: z.string().max(2048),
})
export const replayRequestSchema = base.extend({
	deliveryId: id,
	destination: sendTargetSchema,
	messageId: z.string().min(1).max(128),
	idPolicy: z.enum(['preserve', 'new']),
})
export const resendSnapshotRequestSchema = replayRequestSchema
	.omit({ deliveryId: true })
	.extend({ snapshotId: id })
export type ResendSnapshotRequest = z.infer<typeof resendSnapshotRequestSchema>
export const outcomeRequestSchema = base.extend({ operationId: id })
export const outcomeSchema = z
	.object({
		operationId: id,
		status: z.enum(['confirmed', 'rejected', 'unknown', 'cancelled']),
		summary: z.string().max(2048),
		messageId: z.string().nullable(),
		sequenceNumbers: z.array(sequenceSchema).max(20).optional(),
	})
	.strict()
export const deliverySchema = z
	.object({
		deliveryId: id,
		summary: messageSummarySchema,
		lockedUntil: z.string(),
		state: z.enum([
			'active',
			'completed',
			'abandoned',
			'dead-lettered',
			'deferred',
			'replayed',
			'lock-lost',
			'unknown',
		]),
	})
	.strict()
export const deliveriesSchema = z
	.object({
		target: peekTargetSchema.nullable(),
		subQueue: subQueueSchema,
		sessionId: z.string().nullable(),
		items: z.array(deliverySchema).max(10),
		warning: z.string().nullable(),
		session: sessionLeaseSchema.nullable().optional(),
	})
	.strict()
export type MessageDraft = z.infer<typeof draftSchema>
export type SendTarget = z.infer<typeof sendTargetSchema>
export type SendRequest = z.infer<typeof sendRequestSchema>
export type ReceiveRequest = z.infer<typeof receiveRequestSchema>
export type DeliveriesRequest = z.infer<typeof deliveriesRequestSchema>
export type SettleRequest = z.infer<typeof settleRequestSchema>
export type ReplayRequest = z.infer<typeof replayRequestSchema>
export type OutcomeRequest = z.infer<typeof outcomeRequestSchema>
export type OperationOutcome = z.infer<typeof outcomeSchema>
export type Deliveries = z.infer<typeof deliveriesSchema>
export type Delivery = z.infer<typeof deliverySchema>
