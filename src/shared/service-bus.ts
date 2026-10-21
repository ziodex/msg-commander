import { z } from 'zod'

export const subQueueSchema = z.enum(['active', 'dead-letter', 'transfer-dead-letter'])
export type MessageSubQueue = z.infer<typeof subQueueSchema>
export type DeadLetterSubQueue = Exclude<MessageSubQueue, 'active'>
export const subQueueLabel = (value: MessageSubQueue) =>
	({
		active: 'Messages',
		'dead-letter': 'Dead-letter',
		'transfer-dead-letter': 'Transfer dead-letter',
	})[value]
const id = z.string().uuid()
const name = z.string().min(1).max(260)
export const sequenceSchema = z
	.string()
	.refine(
		(value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
		'Use a decimal sequence number from 0 to 9223372036854775807.',
	)
export const entityTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('queue'), name }).strict(),
	z.object({ kind: z.literal('topic'), name }).strict(),
	z.object({ kind: z.literal('subscription'), name, topicName: name }).strict(),
])
export const peekTargetSchema = z.union([
	entityTargetSchema.options[0],
	entityTargetSchema.options[2],
])
export const connectionRequestSchema = z.object({ id, profileId: id }).strict()
export const disconnectRequestSchema = z.object({ id, connectionId: id }).strict()
export const listRequestSchema = z
	.object({
		id,
		connectionId: id,
		kind: z.enum(['queue', 'topic', 'subscription']),
		topicName: name.optional(),
		continuationToken: z.string().max(16384).nullable().optional(),
	})
	.strict()
	.refine(
		(value) => value.kind !== 'subscription' || !!value.topicName,
		'A subscription needs a topic.',
	)
export const entityRequestSchema = z
	.object({ id, connectionId: id, target: entityTargetSchema })
	.strict()
export const peekRequestSchema = z
	.object({
		id,
		connectionId: id,
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		fromSequenceNumber: sequenceSchema,
		maxMessages: z.number().int().min(1).max(25),
	})
	.strict()
export const inspectRequestSchema = z.object({ id, connectionId: id, snapshotId: id }).strict()
export const bodyRequestSchema = inspectRequestSchema.extend({
	offset: z
		.number()
		.int()
		.min(0)
		.max(64 * 1024 * 1024),
	count: z.number().int().min(1).max(65536),
})
export const connectionSchema = z
	.object({ connectionId: id, profileId: id, namespace: z.string(), connectedAt: z.string() })
	.strict()
export const entitySchema = z
	.object({
		target: entityTargetSchema,
		status: z.string(),
		requiresSession: z.boolean().nullable(),
	})
	.strict()
export const entityPageSchema = z
	.object({
		items: z.array(entitySchema).max(100),
		continuationToken: z.string().max(16384).nullable(),
	})
	.strict()
export const propertySchema = z
	.object({ name: z.string(), type: z.string(), value: z.string() })
	.strict()
export const entityDetailsSchema = z
	.object({
		entity: entitySchema,
		properties: z.array(propertySchema),
		counts: z.object({
			active: sequenceSchema.nullable(),
			deadLetter: sequenceSchema.nullable(),
			scheduled: sequenceSchema.nullable(),
			transfer: sequenceSchema.nullable(),
			transferDeadLetter: sequenceSchema.nullable(),
			total: sequenceSchema.nullable(),
			sizeBytes: sequenceSchema.nullable(),
		}),
		countsWarning: z.string().nullable(),
		fetchedAt: z.string(),
	})
	.strict()
export const messageSummarySchema = z
	.object({
		snapshotId: id.nullable(),
		sequenceNumber: sequenceSchema,
		messageId: z.string().nullable(),
		subject: z.string().nullable(),
		contentType: z.string().nullable(),
		enqueuedTime: z.string(),
		scheduledEnqueueTime: z.string().nullable().optional(),
		state: z.string(),
		deliveryCount: z.number().int(),
		sessionId: z.string().nullable(),
		bodySize: z.number().int().nonnegative(),
		inspectionWarning: z.string().nullable(),
	})
	.strict()
export const peekPageSchema = z
	.object({
		items: z.array(messageSummarySchema).max(25),
		nextSequenceNumber: sequenceSchema.nullable(),
		warning: z.string().nullable(),
		fetchedAt: z.string(),
	})
	.strict()
export const messageDetailsSchema = z
	.object({
		summary: messageSummarySchema,
		systemProperties: z.array(propertySchema),
		applicationProperties: z.array(propertySchema),
	})
	.strict()
export const bodyChunkSchema = z
	.object({
		base64: z.string().max(87384),
		offset: z.number().int(),
		totalBytes: z.number().int(),
		nextOffset: z.number().int().nullable(),
	})
	.strict()
export type EntityTarget = z.infer<typeof entityTargetSchema>
export type PeekTarget = z.infer<typeof peekTargetSchema>
export type NamespaceConnection = z.infer<typeof connectionSchema>
export type Entity = z.infer<typeof entitySchema>
export type EntityPage = z.infer<typeof entityPageSchema>
export type EntityDetails = z.infer<typeof entityDetailsSchema>
export type MessageSummary = z.infer<typeof messageSummarySchema>
export type PeekPage = z.infer<typeof peekPageSchema>
export type MessageDetails = z.infer<typeof messageDetailsSchema>
export type BodyChunk = z.infer<typeof bodyChunkSchema>
export type Property = z.infer<typeof propertySchema>
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>
export type DisconnectRequest = z.infer<typeof disconnectRequestSchema>
export type ListRequest = z.infer<typeof listRequestSchema>
export type EntityRequest = z.infer<typeof entityRequestSchema>
export type PeekRequest = z.infer<typeof peekRequestSchema>
export type InspectRequest = z.infer<typeof inspectRequestSchema>
export type BodyRequest = z.infer<typeof bodyRequestSchema>

export const runtimePageSchema = z
	.object({
		items: z
			.array(
				z
					.object({
						target: entityTargetSchema,
						counts: entityDetailsSchema.shape.counts,
					})
					.strict(),
			)
			.max(100),
		continuationToken: z.string().max(16384).nullable(),
		fetchedAt: z.string(),
	})
	.strict()
export type RuntimePage = z.infer<typeof runtimePageSchema>
export type RuntimeEntity = RuntimePage['items'][number]
