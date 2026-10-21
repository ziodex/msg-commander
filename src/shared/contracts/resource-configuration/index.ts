import { z } from 'zod'
export const messagingServiceSchema = z.enum(['service-bus', 'event-hubs'])
export type MessagingService = z.infer<typeof messagingServiceSchema>
export const messagingConfigTargetSchema = z
	.object({
		kind: z.enum(['queue', 'topic', 'subscription', 'rule', 'hub', 'group', 'policy']),
		name: z.string().min(1).max(260),
		parentKind: z.enum(['namespace', 'queue', 'topic', 'subscription', 'hub']).nullable(),
		parentName: z.string().max(330).nullable(),
	})
	.strict()
export const messagingConfigRequestSchema = z
	.object({
		id: z.string().uuid(),
		connectionId: z.string().uuid(),
		service: messagingServiceSchema,
	})
	.strict()
export const messagingConfigExportSchema = messagingConfigRequestSchema.extend({
	scope: messagingConfigTargetSchema.nullable(),
	format: z.literal('json'),
	includePolicies: z.boolean(),
})
export const messagingConfigEncodedSchema = z
	.object({
		contentBase64: z.string().max(699052),
		count: z.number().int().min(1).max(100),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
const settings = z.record(z.string().max(64), z.unknown())
export const messagingConfigPreviewSchema = z
	.object({
		importId: z.string().uuid(),
		service: messagingServiceSchema,
		sourceNamespace: z.string().max(253),
		destinationNamespace: z.string().max(253),
		expiresAt: z.iso.datetime({ offset: true }),
		entries: z
			.array(
				z
					.object({
						id: z.string().uuid(),
						target: messagingConfigTargetSchema,
						phase: z.enum(['resource', 'forwarding', 'remove-guard', 'activate']),
						action: z.enum(['create', 'update', 'delete', 'blocked']),
						proposed: settings,
						current: settings.nullable(),
						dependsOn: z.array(z.string().uuid()).max(300),
						issue: z.string().max(1024).nullable(),
					})
					.strict(),
			)
			.min(1)
			.max(300),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
export const messagingConfigImportResultSchema = z
	.object({
		cancelled: z.boolean(),
		fileName: z.string().max(1024).optional(),
		preview: messagingConfigPreviewSchema.nullable(),
	})
	.strict()
export const messagingConfigApplySchema = messagingConfigRequestSchema
	.extend({
		importId: z.string().uuid(),
		entryIds: z.array(z.string().uuid()).min(1).max(300),
		acknowledged: z.literal(true),
	})
	.refine((v) => new Set(v.entryIds).size === v.entryIds.length)
export const messagingConfigResultRequestSchema = messagingConfigRequestSchema.extend({
	operationId: z.string().uuid(),
})
export const messagingConfigResultSchema = z
	.object({
		operationId: z.string().uuid(),
		service: messagingServiceSchema,
		status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
		steps: z
			.array(
				z
					.object({
						entryId: z.string().uuid(),
						target: messagingConfigTargetSchema,
						phase: z.enum(['resource', 'forwarding', 'remove-guard', 'activate']),
						status: z.enum([
							'confirmed',
							'failed',
							'cancelled',
							'unknown',
							'not-attempted',
						]),
						summary: z.string().max(1024),
					})
					.strict(),
			)
			.max(300),
	})
	.strict()
export type MessagingConfigTarget = z.infer<typeof messagingConfigTargetSchema>
export type MessagingConfigRequest = z.infer<typeof messagingConfigRequestSchema>
export type MessagingConfigExport = z.infer<typeof messagingConfigExportSchema>
export type MessagingConfigEncoded = z.infer<typeof messagingConfigEncodedSchema>
export type MessagingConfigPreview = z.infer<typeof messagingConfigPreviewSchema>
export type MessagingConfigImportResult = z.infer<typeof messagingConfigImportResultSchema>
export type MessagingConfigApply = z.infer<typeof messagingConfigApplySchema>
export type MessagingConfigResultRequest = z.infer<typeof messagingConfigResultRequestSchema>
export type MessagingConfigResult = z.infer<typeof messagingConfigResultSchema>
export const messagingConfigPath = (target: MessagingConfigTarget) =>
	target.parentName
		? `${target.parentName}/${target.kind}/${target.name}`
		: `${target.kind}/${target.name}`
