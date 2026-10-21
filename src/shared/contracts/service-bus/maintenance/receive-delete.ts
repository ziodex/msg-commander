import { z } from 'zod'
import {
	messageSummarySchema,
	peekTargetSchema,
	subQueueSchema,
	type PeekTarget,
	type MessageSubQueue,
} from '../../../service-bus'
const id = z.string().uuid()
export function receiveDeleteConfirmation(
	namespace: string,
	target: PeekTarget,
	subQueue: MessageSubQueue,
	sessionId: string,
) {
	const path =
		target.kind === 'queue' ? target.name : `${target.topicName}/Subscriptions/${target.name}`
	return `RECEIVE AND DELETE ${namespace}/${path}/${subQueue}${sessionId ? ` session=${sessionId}` : ''}`
}
export const receiveDeleteRequestSchema = z
	.object({
		id,
		connectionId: id,
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		sessionId: z.string().max(128),
		confirmation: z.string().max(1400),
		maxMessages: z.number().int().min(1).max(100),
		maxSeconds: z.number().int().min(1).max(600),
	})
	.strict()
	.refine(
		(v) => v.subQueue === 'active' || !v.sessionId,
		'Dead-letter sources do not accept a session filter.',
	)
export const receiveDeleteResultRequestSchema = z
	.object({ id, connectionId: id, operationId: id })
	.strict()
export const receiveDeleteResultSchema = z
	.object({
		operationId: id,
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		sessionId: z.string().max(128),
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum([
			'no-available-messages',
			'message-limit',
			'time-limit',
			'inspection-limit',
			'cancelled',
			'error',
		]),
		received: z.number().int().nonnegative(),
		uncertain: z.boolean(),
		elapsedMs: z.number().nonnegative(),
		items: z.array(messageSummarySchema).max(100),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(1024).nullable(),
	})
	.strict()
export const receiveDeleteProgressSchema = z
	.object({
		type: z.literal('receive-delete-progress'),
		operationId: id,
		received: z.number().int().nonnegative(),
		maxMessages: z.number().int().min(1).max(100),
		elapsedMs: z.number().nonnegative(),
		phase: z.enum(['opening', 'receiving', 'closing', 'finished']),
	})
	.strict()
export type ReceiveDeleteRequest = z.infer<typeof receiveDeleteRequestSchema>
export type ReceiveDeleteResultRequest = z.infer<typeof receiveDeleteResultRequestSchema>
export type ReceiveDeleteResult = z.infer<typeof receiveDeleteResultSchema>
export type ReceiveDeleteProgress = z.infer<typeof receiveDeleteProgressSchema>
