import { z } from 'zod'
import { entityTargetSchema, type EntityTarget } from './service-bus'

const id = z.string().uuid()
export const bulkEntityKey = (target: EntityTarget) =>
	JSON.stringify([
		target.kind,
		target.kind === 'subscription' ? target.topicName.toLowerCase() : '',
		target.name.toLowerCase(),
	])
export const bulkEntityActionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('delete') }).strict(),
	z
		.object({
			kind: z.literal('status'),
			status: z.enum(['Active', 'Disabled', 'SendDisabled', 'ReceiveDisabled']),
		})
		.strict(),
])
export function supportsBulkStatus(target: EntityTarget, status: string) {
	return !(
		(target.kind === 'topic' && status === 'ReceiveDisabled') ||
		(target.kind === 'subscription' && status === 'SendDisabled')
	)
}
export const bulkEntityPreviewRequestSchema = z
	.object({
		id,
		connectionId: id,
		targets: z.array(entityTargetSchema).min(1).max(100),
		action: bulkEntityActionSchema,
		maxSeconds: z.number().int().min(1).max(600),
	})
	.strict()
	.refine(
		(value) => new Set(value.targets.map(bulkEntityKey)).size === value.targets.length,
		'Select each entity only once.',
	)
	.refine(
		(value) =>
			value.action.kind !== 'status' ||
			value.targets.every((target) =>
				supportsBulkStatus(
					target,
					value.action.kind === 'status' ? value.action.status : '',
				),
			),
		'This status is not supported by every selected entity.',
	)
const previewItem = z
	.object({
		target: entityTargetSchema,
		currentStatus: z.string().max(32),
		subscriptions: z.array(entityTargetSchema).max(500),
	})
	.strict()
export const bulkEntityPlanSchema = z
	.object({
		planId: id,
		namespace: z.string().max(253),
		action: bulkEntityActionSchema,
		items: z.array(previewItem).min(1).max(100),
		affectedCount: z.number().int().min(1).max(500),
		maxSeconds: z.number().int().min(1).max(600),
		expiresAt: z.string(),
		confirmation: z.string().max(512),
	})
	.strict()
export const bulkEntityExecuteRequestSchema = z
	.object({ id, connectionId: id, planId: id, confirmation: z.string().max(512) })
	.strict()
export const bulkEntityResultRequestSchema = z
	.object({ id, connectionId: id, operationId: id })
	.strict()
export const bulkEntityRowSchema = z
	.object({
		target: entityTargetSchema,
		status: z.enum([
			'not-started',
			'confirmed',
			'unchanged',
			'rejected',
			'cancelled',
			'unknown',
		]),
		summary: z.string().max(1024),
	})
	.strict()
const progressFields = {
	operationId: id,
	items: z.array(bulkEntityRowSchema).min(1).max(100),
	confirmed: z.number().int().min(0).max(100),
	uncertain: z.number().int().min(0).max(1),
	elapsedMs: z.number().nonnegative(),
}
export const bulkEntityResultSchema = z
	.object({
		...progressFields,
		plan: bulkEntityPlanSchema,
		status: z.enum(['completed', 'cancelled', 'limited', 'failed', 'unknown']),
		summary: z.string().max(1024),
	})
	.strict()
export const bulkEntityProgressSchema = z
	.object({
		type: z.literal('bulk-entity-progress'),
		...progressFields,
		activeIndex: z.number().int().min(0).max(99).nullable(),
		phase: z.enum(['checking', 'applying', 'finished']),
	})
	.strict()
export type BulkEntityAction = z.infer<typeof bulkEntityActionSchema>
export type BulkEntityPreviewRequest = z.infer<typeof bulkEntityPreviewRequestSchema>
export type BulkEntityPlan = z.infer<typeof bulkEntityPlanSchema>
export type BulkEntityExecuteRequest = z.infer<typeof bulkEntityExecuteRequestSchema>
export type BulkEntityResultRequest = z.infer<typeof bulkEntityResultRequestSchema>
export type BulkEntityResult = z.infer<typeof bulkEntityResultSchema>
export type BulkEntityProgress = z.infer<typeof bulkEntityProgressSchema>
