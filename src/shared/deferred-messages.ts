import { z } from 'zod'
import { peekTargetSchema, sequenceSchema, subQueueSchema } from './service-bus'
export const deferredReferencesRequestSchema = z
	.object({
		id: z.uuid(),
		connectionId: z.uuid(),
		target: peekTargetSchema,
		subQueue: subQueueSchema,
		sessionId: z.string().max(128),
	})
	.strict()
	.refine(
		(value) => value.subQueue === 'active' || value.sessionId === '',
		'Dead-letter references do not use a session filter.',
	)
export const forgetDeferredRequestSchema = deferredReferencesRequestSchema.safeExtend({
	sequenceNumber: sequenceSchema,
})
export const deferredReferencesSchema = z
	.object({
		total: z.number().int().min(0).max(10000),
		items: z
			.array(
				z
					.object({
						sequenceNumber: sequenceSchema,
						recordedAt: z.iso.datetime({ offset: true }),
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
export type DeferredReferencesRequest = z.infer<typeof deferredReferencesRequestSchema>
export type ForgetDeferredRequest = z.infer<typeof forgetDeferredRequestSchema>
export type DeferredReferences = z.infer<typeof deferredReferencesSchema>
