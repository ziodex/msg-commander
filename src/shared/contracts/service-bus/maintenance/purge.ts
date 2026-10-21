import { subQueueSchema, type MessageSubQueue } from '../../../service-bus'
import { z } from 'zod'
import { peekTargetSchema, type PeekTarget } from '../../../service-bus'
const id = z.string().uuid()
// One canonical instant at the IPC boundary, never an implicit machine timezone.
export const purgeCutoffSchema = z.iso
	.datetime({ precision: 3 })
	.refine((value) => !value.startsWith('0000-'))
export function purgeConfirmation(
	namespace: string,
	target: PeekTarget,
	subQueue: MessageSubQueue,
	beforeEnqueueTime?: string,
) {
	const path =
		target.kind === 'queue' ? target.name : `${target.topicName}/Subscriptions/${target.name}`
	return `PURGE ${namespace}/${path}/${subQueue}${beforeEnqueueTime ? ` BEFORE ${beforeEnqueueTime}` : ''}`
}
export const purgeRequestSchema = z
	.object({
		id,
		connectionId: id,
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		confirmation: z.string().max(1024),
		maxMessages: z.number().int().min(1).max(100000),
		maxSeconds: z.number().int().min(1).max(600),
		beforeEnqueueTime: purgeCutoffSchema.optional(),
	})
	.strict()
export const purgeResultRequestSchema = z.object({ id, connectionId: id, operationId: id }).strict()
export const purgeResultSchema = z
	.object({
		operationId: id,
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		status: z.enum(['completed', 'cancelled', 'limited', 'failed', 'unknown']),
		reason: z.enum([
			'no-available-messages',
			'message-limit',
			'time-limit',
			'cancelled',
			'error',
			'retention-limit',
			'scan-limit',
			'redelivery',
			'session-revisited',
		]),
		beforeEnqueueTime: purgeCutoffSchema.nullable(),
		skipped: z.number().int().min(0).max(100),
		received: z.number().int().nonnegative().max(100000),
		completed: z.number().int().nonnegative().max(100000),
		uncertain: z.number().int().min(0).max(1),
		elapsedMs: z.number().nonnegative(),
		summary: z.string().max(1024),
		cleanupWarning: z.string().max(512).nullable(),
	})
	.strict()
export const purgeProgressSchema = z
	.object({
		type: z.literal('purge-progress'),
		operationId: id,
		beforeEnqueueTime: purgeCutoffSchema.nullable(),
		skipped: z.number().int().min(0).max(100),
		received: z.number().int().nonnegative().max(100000),
		completed: z.number().int().nonnegative().max(100000),
		uncertain: z.number().int().min(0).max(1),
		maxMessages: z.number().int().min(1).max(100000),
		elapsedMs: z.number().nonnegative(),
		phase: z.enum([
			'opening',
			'receiving',
			'completing',
			'renewing',
			'retaining',
			'closing',
			'finished',
		]),
	})
	.strict()
export type PurgeRequest = z.infer<typeof purgeRequestSchema>
export type PurgeResultRequest = z.infer<typeof purgeResultRequestSchema>
export type PurgeResult = z.infer<typeof purgeResultSchema>
export type PurgeProgress = z.infer<typeof purgeProgressSchema>
