import { z } from 'zod'
import { peekTargetSchema } from './service-bus'
const id = z.string().uuid()
const base = z.object({ id, connectionId: id }).strict()
export const listSessionsRequestSchema = base.extend({
	target: peekTargetSchema,
	continuationToken: id.nullable(),
})
export const closeSessionScanRequestSchema = base.extend({ continuationToken: id })
export const acceptSessionRequestSchema = base.extend({
	target: peekTargetSchema,
	sessionId: z
		.string()
		.min(1)
		.max(128)
		.refine((value) => !!value.trim(), 'Enter a session ID.'),
})
export const sessionRequestSchema = base.extend({ leaseId: id })
export const setSessionStateRequestSchema = sessionRequestSchema.extend({
	bodyBase64: z.string().max(349528).nullable(),
	expectedRevision: z.string().regex(/^[A-F0-9]{64}$/),
	confirmation: z.string().max(128),
})
export const sessionPageSchema = z
	.object({
		items: z.array(z.string().min(1).max(128)).max(100),
		continuationToken: id.nullable(),
	})
	.strict()
export const sessionLeaseSchema = z
	.object({
		leaseId: id,
		target: peekTargetSchema,
		sessionId: z.string().min(1).max(128),
		lockedUntil: z.string(),
		status: z.enum(['active', 'lock-lost', 'unknown']),
		stateUncertain: z.boolean(),
	})
	.strict()
export const sessionStateSchema = z
	.object({
		leaseId: id,
		isSet: z.boolean(),
		bytes: z.number().int().nonnegative(),
		bodyBase64: z.string().max(349528).nullable(),
		revision: z
			.string()
			.regex(/^[A-F0-9]{64}$/)
			.nullable(),
		editable: z.boolean(),
		warning: z.string().nullable(),
	})
	.strict()
export type ListSessionsRequest = z.infer<typeof listSessionsRequestSchema>
export type CloseSessionScanRequest = z.infer<typeof closeSessionScanRequestSchema>
export type AcceptSessionRequest = z.infer<typeof acceptSessionRequestSchema>
export type SessionRequest = z.infer<typeof sessionRequestSchema>
export type SetSessionStateRequest = z.infer<typeof setSessionStateRequestSchema>
export type SessionPage = z.infer<typeof sessionPageSchema>
export type SessionLease = z.infer<typeof sessionLeaseSchema>
export type SessionState = z.infer<typeof sessionStateSchema>
