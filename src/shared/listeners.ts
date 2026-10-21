import { z } from 'zod'
import { peekTargetSchema, messageSummarySchema } from './service-bus'
const id = z.string().uuid()
export const listenerStatusRequestSchema = z.object({ id, connectionId: id }).strict()
export const listenerStartSchema = listenerStatusRequestSchema
	.extend({
		target: peekTargetSchema,
		sessionId: z.string().max(128),
		sessionMode: z.enum(['single', 'next-available']).optional(),
		maxConcurrentSessions: z.number().int().min(1).max(8).optional(),
		sessionIdleSeconds: z.number().int().min(1).max(30).optional(),
		mode: z.enum(['manual', 'auto-complete']),
		maxMessages: z.number().int().min(1).max(100000),
		maxSeconds: z.number().int().min(1).max(86400),
		maxLockSeconds: z.number().int().min(1).max(3600),
	})
	.refine(
		(value) => value.mode !== 'manual' || value.maxMessages <= 1000,
		'Manual listeners support at most 1,000 deliveries per run.',
	)
	.refine(
		(value) => value.sessionMode !== 'next-available' || value.sessionId === '',
		'Automatic session selection cannot specify a session ID.',
	)
	.refine(
		(value) =>
			value.sessionMode === 'next-available' || (value.maxConcurrentSessions ?? 1) === 1,
		'Single-source listeners use one receiver.',
	)
export const listenerRequestSchema = listenerStatusRequestSchema.extend({ listenerId: id })
export const listenerSettleSchema = listenerRequestSchema.extend({
	deliveryId: id,
	action: z.enum(['complete', 'abandon', 'dead-letter', 'defer']),
	reason: z.string().max(128),
	description: z.string().max(4096),
})
export const listenerItemSchema = z
	.object({
		deliveryId: id,
		summary: messageSummarySchema,
		state: z.enum([
			'active',
			'settling',
			'completed',
			'abandoned',
			'dead-lettered',
			'deferred',
			'lock-lost',
			'unknown',
			'released',
		]),
		lockedUntil: z.string(),
		receivedAt: z.string(),
	})
	.strict()
export const listenerSessionSchema = z
	.object({
		sessionId: z.string().min(1).max(128),
		status: z.enum(['receiving', 'waiting', 'idle', 'released', 'failed', 'unknown']),
		received: z.number().int().nonnegative(),
		completed: z.number().int().nonnegative(),
		abandoned: z.number().int().nonnegative(),
		deadLettered: z.number().int().nonnegative(),
		deferred: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		uncertain: z.number().int().nonnegative(),
		renewed: z.number().int().nonnegative(),
		pending: z.number().int().min(0).max(1),
		lockedUntil: z.string().nullable(),
		summary: z.string().max(512),
	})
	.strict()
export const listenerStateSchema = z
	.object({
		listenerId: id,
		connectionId: id,
		target: peekTargetSchema,
		sessionId: z.string().nullable(),
		mode: z.enum(['manual', 'auto-complete']),
		status: z.enum(['running', 'stopping', 'stopped', 'limited', 'failed', 'unknown']),
		received: z.number().int().nonnegative(),
		completed: z.number().int().nonnegative(),
		abandoned: z.number().int().nonnegative(),
		deadLettered: z.number().int().nonnegative(),
		deferred: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		uncertain: z.number().int().min(0).max(8),
		renewed: z.number().int().nonnegative(),
		elapsedMs: z.number().nonnegative(),
		maxMessages: z.number().int().min(1).max(100000),
		maxSeconds: z.number().int().min(1).max(86400),
		maxLockSeconds: z.number().int().min(1).max(3600),
		retainedBytes: z.number().int().min(0).max(16777216),
		evicted: z.number().int().nonnegative(),
		summary: z.string().max(2048),
		items: z.array(listenerItemSchema).max(100),
		sessionMode: z.enum(['single', 'next-available']),
		maxConcurrentSessions: z.number().int().min(1).max(8),
		sessionIdleSeconds: z.number().int().min(1).max(30),
		activeSessions: z.number().int().min(0).max(8),
		acceptingSessions: z.number().int().min(0).max(8),
		sessionAcquisitions: z.number().int().nonnegative(),
		sessionHistoryEvicted: z.number().int().nonnegative(),
		sessions: z.array(listenerSessionSchema).max(100),
	})
	.strict()
export type ListenerStart = z.infer<typeof listenerStartSchema>
export type ListenerRequest = z.infer<typeof listenerRequestSchema>
export type ListenerStatusRequest = z.infer<typeof listenerStatusRequestSchema>
export type ListenerSettle = z.infer<typeof listenerSettleSchema>
export type ListenerState = z.infer<typeof listenerStateSchema>
export type ListenerItem = z.infer<typeof listenerItemSchema>
