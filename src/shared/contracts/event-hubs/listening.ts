import { z } from 'zod'
import { documentFormatSchema } from '../../document-formats'
import { eventOperationStatisticsSchema } from './statistics'
import {
	eventHubRequestSchema,
	eventHubsRequestSchema,
	eventHubNameSchema,
	consumerGroupSchema,
	eventPositionSchema,
	eventSummarySchema,
} from './core'
import { sequenceSchema } from '../../service-bus'
const partitionId = z.string().regex(/^[0-9]{1,10}$/)
export const checkpointPartitionSchema = z
	.object({
		partitionId,
		position: z.union([eventPositionSchema.options[2], eventPositionSchema.options[4]]),
		retentionFloor: sequenceSchema,
	})
	.strict()
export const eventCheckpointSchema = z
	.object({
		format: documentFormatSchema('event-checkpoints'),
		version: z.literal(1),
		namespace: z
			.string()
			.max(253)
			.regex(/^[a-z0-9-]+\.servicebus\.windows\.net$/i),
		hubName: eventHubNameSchema,
		consumerGroup: consumerGroupSchema,
		hubCreatedAt: z.iso.datetime({ offset: true }),
		savedAt: z.iso.datetime({ offset: true }),
		partitions: z.array(checkpointPartitionSchema).min(1).max(1024),
	})
	.strict()
	.refine(
		(v) => new Set(v.partitions.map((p) => p.partitionId)).size === v.partitions.length,
		'Checkpoint partitions must be unique.',
	)
export const eventListenSchema = eventHubRequestSchema.extend({
	consumerGroup: consumerGroupSchema,
	start: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('earliest') }).strict(),
		z.object({ kind: z.literal('latest') }).strict(),
		z.object({ kind: z.literal('time'), value: z.iso.datetime({ offset: true }) }).strict(),
		z.object({ kind: z.literal('checkpoint'), checkpoint: eventCheckpointSchema }).strict(),
	]),
	concurrency: z.number().int().min(1).max(16),
	maxEvents: z.number().int().min(1).max(1000),
	maxSeconds: z.number().int().min(1).max(3600),
	acknowledged: z.literal(true),
})
export const eventListenResultRequestSchema = eventHubsRequestSchema.extend({
	operationId: z.string().uuid(),
})
export const listenerPartitionSchema = z
	.object({
		partitionId,
		status: z.enum(['queued', 'reading', 'waiting', 'stopped', 'failed']),
		received: z.number().int().min(0).max(1000),
		bytes: z.number().int().nonnegative(),
		lastSequence: sequenceSchema.nullable(),
		error: z.string().max(512).nullable(),
	})
	.strict()
export const listenerItemSchema = eventSummarySchema.extend({ partitionId })
export const eventListenProgressSchema = z
	.object({
		type: z.literal('event-hub-listen-progress'),
		statistics: eventOperationStatisticsSchema.nullable().optional(),
		operationId: z.string().uuid(),
		received: z.number().int().min(0).max(1000),
		maxEvents: z.number().int().min(1).max(1000),
		elapsedMs: z.number().nonnegative(),
		activeReceivers: z.number().int().min(0).max(16),
		phase: z.enum(['validating', 'listening', 'closing', 'finished']),
		partitions: z.array(listenerPartitionSchema).max(1024),
	})
	.strict()
export const eventListenResultSchema = z
	.object({
		operationId: z.string().uuid(),
		hubName: eventHubNameSchema,
		consumerGroup: consumerGroupSchema,
		concurrency: z.number().int().min(1).max(16),
		maxEvents: z.number().int().min(1).max(1000),
		maxSeconds: z.number().int().min(1).max(3600),
		status: z.enum(['completed', 'limited', 'cancelled', 'failed']),
		reason: z.enum(['count', 'time', 'cancelled', 'buffer-limit', 'error']),
		received: z.number().int().min(0).max(1000),
		elapsedMs: z.number().nonnegative(),
		partitions: z.array(listenerPartitionSchema).max(1024),
		items: z.array(listenerItemSchema).max(1000),
		checkpoint: eventCheckpointSchema.nullable(),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
		statistics: eventOperationStatisticsSchema.nullable().optional(),
	})
	.strict()
export type EventCheckpoint = z.infer<typeof eventCheckpointSchema>
export type EventListen = z.infer<typeof eventListenSchema>
export type EventListenResultRequest = z.infer<typeof eventListenResultRequestSchema>
export type EventListenResult = z.infer<typeof eventListenResultSchema>
export type EventListenProgress = z.infer<typeof eventListenProgressSchema>
export type ListenerItem = z.infer<typeof listenerItemSchema>
