import { z } from 'zod'
import { eventOperationStatisticsSchema } from './statistics'
import {
	bodyChunkSchema,
	bodyRequestSchema,
	inspectRequestSchema,
	propertySchema,
	sequenceSchema,
} from '../../service-bus'
const id = z.string().uuid()
export const eventHubNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const consumerGroupSchema = z.union([
	z.literal('$Default'),
	z
		.string()
		.min(1)
		.max(50)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
])
const partition = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[0-9]+$/)
export const eventHubsManagementSchema = z
	.object({
		resourceId: z
			.string()
			.max(1024)
			.regex(
				/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft\.EventHub\/namespaces\/[a-z0-9-]{6,50}$/i,
			),
		tenantId: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9.-]+$/),
		clientId: id,
	})
	.strict()
export const eventHubsConnectSchema = z
	.object({
		id,
		profileId: id,
		access: z.enum(['read', 'send']).optional(),
		hubName: z.union([z.literal(''), eventHubNameSchema]),
		management: eventHubsManagementSchema.nullable(),
	})
	.strict()
	.refine((v) => !!v.hubName || !!v.management, 'Enter a hub name or enable namespace browsing.')
export const eventHubsRequestSchema = z.object({ id, connectionId: id }).strict()
export const eventHubRequestSchema = eventHubsRequestSchema.extend({ hubName: eventHubNameSchema })
export const eventHubsListSchema = eventHubsRequestSchema
	.extend({
		kind: z.enum(['hubs', 'groups']),
		hubName: z.union([z.literal(''), eventHubNameSchema]),
		continuationToken: id.nullable(),
	})
	.refine((v) => (v.kind === 'hubs' ? !v.hubName : !!v.hubName))
export const eventHubPartitionRequestSchema = eventHubRequestSchema.extend({
	partitionId: partition,
})
export const eventPositionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('earliest') }).strict(),
	z.object({ kind: z.literal('latest') }).strict(),
	z
		.object({ kind: z.literal('sequence'), value: sequenceSchema, inclusive: z.boolean() })
		.strict(),
	z
		.object({
			kind: z.literal('offset'),
			value: z
				.string()
				.min(1)
				.max(256)
				.regex(/^[^\s\x00-\x1f]+$/),
			inclusive: z.boolean(),
		})
		.strict(),
	z.object({ kind: z.literal('time'), value: z.iso.datetime({ offset: true }) }).strict(),
])
export const eventHubReadSchema = eventHubPartitionRequestSchema.extend({
	consumerGroup: consumerGroupSchema,
	position: eventPositionSchema,
	maxEvents: z.number().int().min(1).max(100),
	maxSeconds: z.number().int().min(1).max(300),
})
export const eventHubReadResultRequestSchema = eventHubsRequestSchema.extend({ operationId: id })
export const eventHubSchema = z
	.object({
		name: eventHubNameSchema,
		partitionIds: z.array(partition).max(1024),
		createdAt: z.string().max(64),
	})
	.strict()
export const eventHubsConnectionSchema = z
	.object({
		connectionId: id,
		profileId: id,
		namespace: z.string().max(253),
		connectedAt: z.string().max(64),
		managementAvailable: z.boolean(),
		service: z.enum(['event-hubs', 'iot-hub']).optional(),
		access: z.enum(['read', 'send']),
		initialHub: eventHubSchema.nullable(),
	})
	.strict()
export const eventHubsPageSchema = z
	.object({
		items: z
			.array(
				z
					.object({
						name: z.string().max(256),
						status: z.string().max(64).nullable(),
						partitionCount: z.number().int().nullable(),
						userMetadata: z.string().max(1024).nullable(),
					})
					.strict(),
			)
			.max(250),
		continuationToken: id.nullable(),
	})
	.strict()
export const eventHubPartitionSchema = z
	.object({
		hubName: eventHubNameSchema,
		partitionId: partition,
		isEmpty: z.boolean(),
		beginningSequence: sequenceSchema.nullable(),
		lastSequence: sequenceSchema.nullable(),
		lastOffset: z.string().max(256).nullable(),
		lastEnqueuedTime: z.string().max(64).nullable(),
	})
	.strict()
export const eventSummarySchema = z
	.object({
		snapshotId: id.nullable(),
		sequenceNumber: sequenceSchema,
		offset: z.string().max(256),
		enqueuedTime: z.string().max(64),
		partitionKey: z.string().max(256).nullable(),
		bodySize: z.number().int().nonnegative(),
		warning: z.string().max(1024).nullable(),
	})
	.strict()
export const eventHubReadResultSchema = z
	.object({
		operationId: id,
		hubName: eventHubNameSchema,
		consumerGroup: consumerGroupSchema,
		partitionId: partition,
		position: eventPositionSchema,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed']),
		reason: z.enum(['count', 'time', 'cancelled', 'buffer-limit', 'error']),
		received: z.number().int().nonnegative(),
		elapsedMs: z.number().nonnegative(),
		items: z.array(eventSummarySchema).max(100),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
		statistics: eventOperationStatisticsSchema.nullable().optional(),
	})
	.strict()
export const eventHubReadProgressSchema = z
	.object({
		type: z.literal('event-hub-read-progress'),
		statistics: eventOperationStatisticsSchema.nullable().optional(),
		operationId: id,
		received: z.number().int().nonnegative(),
		maxEvents: z.number().int().min(1).max(100),
		elapsedMs: z.number().nonnegative(),
		phase: z.enum(['opening', 'reading', 'closing', 'finished']),
	})
	.strict()
export const eventDetailsSchema = z
	.object({
		summary: eventSummarySchema,
		messageId: z.string().max(256).nullable(),
		contentType: z.string().max(256).nullable(),
		correlationId: z.string().max(256).nullable(),
		applicationProperties: z.array(propertySchema).max(64),
		systemProperties: z.array(propertySchema).max(64),
		warning: z.string().max(1024).nullable(),
	})
	.strict()
export {
	bodyChunkSchema as eventBodySchema,
	bodyRequestSchema as eventBodyRequestSchema,
	inspectRequestSchema as eventInspectRequestSchema,
}
export type EventHubsConnect = z.infer<typeof eventHubsConnectSchema>
export type EventHubsManagement = z.infer<typeof eventHubsManagementSchema>
export type EventHubsRequest = z.infer<typeof eventHubsRequestSchema>
export type EventHubRequest = z.infer<typeof eventHubRequestSchema>
export type EventHubsList = z.infer<typeof eventHubsListSchema>
export type EventHubPartitionRequest = z.infer<typeof eventHubPartitionRequestSchema>
export type EventPosition = z.infer<typeof eventPositionSchema>
export type EventHubRead = z.infer<typeof eventHubReadSchema>
export type EventHubReadResultRequest = z.infer<typeof eventHubReadResultRequestSchema>
export type EventHubsConnection = z.infer<typeof eventHubsConnectionSchema>
export type EventHubInfo = z.infer<typeof eventHubSchema>
export type EventHubsPage = z.infer<typeof eventHubsPageSchema>
export type EventHubPartition = z.infer<typeof eventHubPartitionSchema>
export type EventSummary = z.infer<typeof eventSummarySchema>
export type EventDetails = z.infer<typeof eventDetailsSchema>
export type EventHubReadResult = z.infer<typeof eventHubReadResultSchema>
export type EventHubReadProgress = z.infer<typeof eventHubReadProgressSchema>

export const eventHubStatisticsSchema = z
	.object({
		hub: eventHubSchema,
		startedAt: z.iso.datetime({ offset: true }),
		capturedAt: z.iso.datetime({ offset: true }),
		partitions: z
			.array(
				z
					.object({
						partitionId: partition,
						metadata: eventHubPartitionSchema.nullable(),
						error: z.string().max(160).nullable(),
					})
					.strict(),
			)
			.max(1024),
	})
	.strict()
export const eventHubUrlTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('namespace') }).strict(),
	z.object({ kind: z.literal('hub'), hubName: eventHubNameSchema }).strict(),
	z
		.object({
			kind: z.literal('group'),
			hubName: eventHubNameSchema,
			consumerGroup: consumerGroupSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('partition'),
			hubName: eventHubNameSchema,
			consumerGroup: consumerGroupSchema,
			partitionId: partition,
		})
		.strict(),
])
export const eventHubCopyUrlSchema = eventHubsRequestSchema.extend({
	scheme: z.enum(['https', 'sb']),
	target: eventHubUrlTargetSchema,
})
export type EventHubStatistics = z.infer<typeof eventHubStatisticsSchema>
export type EventHubUrlTarget = z.infer<typeof eventHubUrlTargetSchema>
export type EventHubCopyUrl = z.infer<typeof eventHubCopyUrlSchema>
