import { z } from 'zod'
import { entityTargetSchema, entityDetailsSchema } from './service-bus'
import { entityPath, entitySettingsSchema } from './entity-management'
const id = z.string().uuid()
const base = z.object({ id, connectionId: id }).strict()
export const entityCopySpecSchema = z
	.object({
		source: entityTargetSchema,
		destination: entityTargetSchema,
		mode: z.enum(['duplicate', 'rename']),
		includeSubscriptions: z.boolean(),
	})
	.strict()
	.superRefine((spec, ctx) => {
		if (
			spec.source.kind !== spec.destination.kind ||
			entityPath(spec.source).toLowerCase() === entityPath(spec.destination).toLowerCase()
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose a different destination of the same kind.',
			})
		if (
			(spec.source.kind !== 'topic' && spec.includeSubscriptions) ||
			(spec.mode === 'rename' && spec.source.kind === 'topic' && !spec.includeSubscriptions)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Topic renames must include their subscriptions.',
			})
		if (
			spec.mode === 'rename' &&
			spec.source.kind === 'subscription' &&
			spec.destination.kind === 'subscription' &&
			spec.source.topicName.toLowerCase() !== spec.destination.topicName.toLowerCase()
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Rename subscriptions within their current topic.',
			})
	})
export const previewEntityCopySchema = base.extend({ spec: entityCopySpecSchema })
export const executeEntityCopySchema = base.extend({
	planId: id,
	confirmation: z.string().max(1600),
})
export const entityCopyResultRequestSchema = base.extend({ operationId: id })
export const finishEntityRenameSchema = base.extend({
	reviewId: id,
	confirmation: z.string().max(1600),
})
const rule = z
	.object({ name: z.string().max(50), filterType: z.string().max(32), hasAction: z.boolean() })
	.strict()
export const entityCopyPreviewSchema = z
	.object({
		planId: id,
		spec: entityCopySpecSchema,
		entities: z
			.array(
				z
					.object({
						source: entityTargetSchema,
						destination: entityTargetSchema,
						settings: entitySettingsSchema,
						rules: z.array(rule).max(200),
					})
					.strict(),
			)
			.min(1)
			.max(50),
		stepCount: z.number().int().min(1).max(351),
		expiresOn: z.string().max(64),
	})
	.strict()
export const entityCopyResultSchema = z
	.object({
		operationId: id,
		planId: id,
		spec: entityCopySpecSchema,
		status: z.enum(['running', 'confirmed', 'partial', 'cancelled', 'rejected', 'unknown']),
		steps: z
			.array(
				z
					.object({
						index: z.number().int().positive(),
						action: z.string().max(64),
						target: entityTargetSchema,
						ruleName: z.string().max(50).nullable(),
						status: z.enum([
							'running',
							'confirmed',
							'cancelled',
							'rejected',
							'unknown',
						]),
					})
					.strict(),
			)
			.max(351),
		summary: z.string().max(1024),
		canFinishRename: z.boolean(),
	})
	.strict()
export const entityRenameReviewSchema = z
	.object({
		reviewId: id,
		copyOperationId: id,
		source: entityTargetSchema,
		destination: entityTargetSchema,
		entities: z
			.array(
				z
					.object({
						target: entityTargetSchema,
						status: z.string().max(32),
						counts: entityDetailsSchema.shape.counts,
					})
					.strict(),
			)
			.max(50),
		blockers: z.array(z.string().max(1024)).max(100),
		expiresOn: z.string().max(64),
	})
	.strict()
export type EntityCopySpec = z.infer<typeof entityCopySpecSchema>
export type EntityCopyPreview = z.infer<typeof entityCopyPreviewSchema>
export type EntityCopyResult = z.infer<typeof entityCopyResultSchema>
export type EntityRenameReview = z.infer<typeof entityRenameReviewSchema>
export type PreviewEntityCopyRequest = z.infer<typeof previewEntityCopySchema>
export type ExecuteEntityCopyRequest = z.infer<typeof executeEntityCopySchema>
export type EntityCopyResultRequest = z.infer<typeof entityCopyResultRequestSchema>
export type FinishEntityRenameRequest = z.infer<typeof finishEntityRenameSchema>
export function entityCopyConfirmation(
	namespace: string,
	spec: EntityCopySpec,
	removeSource = false,
) {
	return `${removeSource ? 'DELETE RENAMED SOURCE' : spec.mode === 'rename' ? 'PREPARE RENAME' : 'DUPLICATE'} ${namespace}/${spec.source.kind}/${entityPath(spec.source)} -> ${entityPath(spec.destination)}`
}
