import { z } from 'zod'
import { peekTargetSchema, sequenceSchema } from '../../../service-bus'
import { sendTargetSchema } from '../../../message-operations'
const id = z.string().uuid()
export const resendRequestSchema = z
	.object({
		id,
		connectionId: id,
		source: peekTargetSchema,
		subQueue: z.enum(['dead-letter', 'transfer-dead-letter']).optional(),
		destination: sendTargetSchema,
		destinationProfileId: id.optional(),
		destinationNamespace: z.string().min(1).max(253).optional(),
		acknowledgeNonAtomic: z.boolean().optional(),
		mode: z.enum(['keep', 'remove']),
		idPolicy: z.enum(['new', 'preserve']),
		maxMessages: z.number().int().min(1).max(1000),
		maxSeconds: z.number().int().min(1).max(600),
	})
	.strict()
	.refine(
		(v) => !!v.destinationProfileId === !!v.destinationNamespace,
		'Choose a destination profile and namespace together.',
	)
	.refine(
		(v) => !v.destinationProfileId || v.mode !== 'remove' || v.acknowledgeNonAtomic === true,
		'Acknowledge the separate destination send and source completion.',
	)
export const resendTransferSchema = z
	.object({
		sourceSequenceNumber: sequenceSchema,
		originalMessageId: z.string().max(128).nullable(),
		outgoingMessageId: z.string().max(128),
		send: z.enum(['not-sent', 'confirmed', 'unknown']),
		source: z.enum(['kept', 'not-removed', 'removed', 'unknown']),
	})
	.strict()
export const resendResultRequestSchema = z
	.object({ id, connectionId: id, operationId: id })
	.strict()
const counts = {
	examined: z.number().int().min(0).max(1000),
	sent: z.number().int().min(0).max(1000),
	removed: z.number().int().min(0).max(1000),
	uncertain: z.number().int().min(0).max(1),
	elapsedMs: z.number().nonnegative(),
}
export const resendResultSchema = z
	.object({
		operationId: id,
		sourceNamespace: z.string().min(1).max(253),
		destinationNamespace: z.string().min(1).max(253),
		crossNamespace: z.boolean(),
		copiedNotRemoved: z.number().int().min(0).max(1000),
		transfers: z.array(resendTransferSchema).max(1000),
		source: peekTargetSchema,
		subQueue: z.enum(['dead-letter', 'transfer-dead-letter']),
		destination: sendTargetSchema,
		mode: z.enum(['keep', 'remove']),
		idPolicy: z.enum(['new', 'preserve']),
		status: z.enum(['completed', 'limited', 'cancelled', 'failed', 'unknown']),
		reason: z.enum([
			'no-available-messages',
			'message-limit',
			'time-limit',
			'feedback-detected',
			'receipt-limit',
			'cancelled',
			'error',
		]),
		...counts,
		sourceSequenceNumber: sequenceSchema.nullable(),
		outgoingMessageId: z.string().max(128).nullable(),
		summary: z.string().max(2048),
		cleanupWarning: z.string().max(512).nullable(),
	})
	.strict()
export const resendProgressSchema = z
	.object({
		type: z.literal('resend-progress'),
		operationId: id,
		...counts,
		maxMessages: z.number().int().min(1).max(1000),
		copiedNotRemoved: z.number().int().min(0).max(1000).optional(),
		phase: z.enum([
			'opening',
			'authenticating',
			'completing',
			'peeking',
			'receiving',
			'sending',
			'transferring',
			'closing',
			'finished',
		]),
	})
	.strict()
export type ResendRequest = z.infer<typeof resendRequestSchema>
export type ResendResultRequest = z.infer<typeof resendResultRequestSchema>
export type ResendResult = z.infer<typeof resendResultSchema>
export type ResendProgress = z.infer<typeof resendProgressSchema>
