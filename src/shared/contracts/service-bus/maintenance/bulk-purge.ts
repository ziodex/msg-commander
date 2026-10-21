import { z } from 'zod'
import { peekTargetSchema, subQueueSchema, sequenceSchema } from '../../../service-bus'
import { purgeProgressSchema, purgeResultSchema, purgeCutoffSchema } from './purge'

const id = z.string().uuid()
const limit = z.number().int().min(1).max(100000)
export const bulkPurgeTargetSchema = z
	.object({ target: peekTargetSchema, subQueue: subQueueSchema })
	.strict()
export const bulkPurgeKey = (item: BulkPurgeTarget) =>
	JSON.stringify([
		item.target.kind,
		item.target.kind === 'subscription' ? item.target.topicName.toLowerCase() : '',
		item.target.name.toLowerCase(),
		item.subQueue,
	])
export const bulkPurgePreviewRequestSchema = z
	.object({
		id,
		connectionId: id,
		targets: z.array(bulkPurgeTargetSchema).min(1).max(100),
		maxPerTarget: limit,
		maxTotal: limit,
		maxSeconds: z.number().int().min(1).max(600),
		beforeEnqueueTime: purgeCutoffSchema.optional(),
	})
	.strict()
	.refine(
		(value) => new Set(value.targets.map(bulkPurgeKey)).size === value.targets.length,
		'Select each entity/subqueue only once.',
	)
export const bulkPurgePlanSchema = z
	.object({
		planId: id,
		namespace: z.string().max(253),
		items: z
			.array(bulkPurgeTargetSchema.extend({ estimatedCount: sequenceSchema.nullable() }))
			.min(1)
			.max(100),
		maxPerTarget: limit,
		maxTotal: limit,
		maxSeconds: z.number().int().min(1).max(600),
		beforeEnqueueTime: purgeCutoffSchema.nullable(),
		expiresAt: z.string(),
		confirmation: z.string().max(512),
	})
	.strict()
export const bulkPurgeRequestSchema = z
	.object({ id, connectionId: id, planId: id, confirmation: z.string().max(512) })
	.strict()
export const bulkPurgeResultRequestSchema = z
	.object({ id, connectionId: id, operationId: id })
	.strict()
const row = bulkPurgeTargetSchema.extend({ result: purgeResultSchema.nullable() })
const counts = {
	received: z.number().int().min(0).max(110100),
	skipped: z.number().int().min(0).max(10000),
	completed: z.number().int().min(0).max(100000),
	uncertain: z.number().int().min(0).max(1),
	elapsedMs: z.number().nonnegative(),
}
export const bulkPurgeResultSchema = z
	.object({
		operationId: id,
		plan: bulkPurgePlanSchema,
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum([
			'targets-finished',
			'total-limit',
			'time-limit',
			'cancelled',
			'target-error',
			'target-limits',
			'cleanup-error',
		]),
		items: z.array(row).min(1).max(100),
		...counts,
		summary: z.string().max(1024),
	})
	.strict()
export const bulkPurgeProgressSchema = z
	.object({
		type: z.literal('bulk-purge-progress'),
		operationId: id,
		activeIndex: z.number().int().min(0).max(99).nullable(),
		current: purgeProgressSchema.nullable(),
		items: z.array(row).min(1).max(100),
		...counts,
		phase: z.enum(['running', 'finished']),
	})
	.strict()
export type BulkPurgeTarget = z.infer<typeof bulkPurgeTargetSchema>
export type BulkPurgePreviewRequest = z.infer<typeof bulkPurgePreviewRequestSchema>
export type BulkPurgePlan = z.infer<typeof bulkPurgePlanSchema>
export type BulkPurgeRequest = z.infer<typeof bulkPurgeRequestSchema>
export type BulkPurgeResultRequest = z.infer<typeof bulkPurgeResultRequestSchema>
export type BulkPurgeResult = z.infer<typeof bulkPurgeResultSchema>
export type BulkPurgeProgress = z.infer<typeof bulkPurgeProgressSchema>
