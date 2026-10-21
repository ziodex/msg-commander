import { z } from 'zod'
import {
	nhRequestSchema,
	nhScopeSchema,
	nhTargetSchema,
	nhSettingsSchema,
	nhOutcomeSchema,
} from './core'
import { authorizationRightsSchema } from '../../authorization'
export const nhConfigFormatSchema = z.literal('json')
export const nhConfigExportSchema = nhRequestSchema.extend({
	scope: nhScopeSchema,
	format: nhConfigFormatSchema,
})
export const nhConfigEncodedSchema = z
	.object({
		contentBase64: z.string().max(349528),
		count: z.number().int().min(1).max(100),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
export const nhConfigEntrySchema = z
	.object({
		id: z.string().uuid(),
		target: nhTargetSchema,
		action: z.enum(['create', 'update', 'blocked']),
		settings: nhSettingsSchema.nullable(),
		rights: authorizationRightsSchema.nullable(),
		currentSettings: nhSettingsSchema.nullable(),
		currentRights: authorizationRightsSchema.nullable(),
		issue: z.string().max(1024).nullable(),
	})
	.strict()
export const nhConfigPreviewSchema = z
	.object({
		importId: z.string().uuid(),
		sourceNamespace: z.string().max(253),
		destinationNamespace: z.string().max(253),
		expiresAt: z.string().max(64),
		entries: z.array(nhConfigEntrySchema).min(1).max(100),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
export const nhConfigImportResultSchema = z
	.object({
		cancelled: z.boolean(),
		fileName: z.string().max(1024).optional(),
		preview: nhConfigPreviewSchema.nullable(),
	})
	.strict()
export const nhConfigApplySchema = nhRequestSchema
	.extend({
		importId: z.string().uuid(),
		entryIds: z.array(z.string().uuid()).min(1).max(100),
		acknowledged: z.literal(true),
	})
	.refine((v) => new Set(v.entryIds).size === v.entryIds.length)
export const nhConfigResultSchema = z
	.object({
		operationId: z.string().uuid(),
		status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
		steps: z
			.array(
				z
					.object({
						target: nhTargetSchema,
						status: z.enum([
							'confirmed',
							'failed',
							'cancelled',
							'unknown',
							'not-attempted',
						]),
						receipt: nhOutcomeSchema.nullable(),
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
export type NotificationHubConfigExport = z.infer<typeof nhConfigExportSchema>
export type NotificationHubConfigEncoded = z.infer<typeof nhConfigEncodedSchema>
export type NotificationHubConfigPreview = z.infer<typeof nhConfigPreviewSchema>
export type NotificationHubConfigImportResult = z.infer<typeof nhConfigImportResultSchema>
export type NotificationHubConfigApply = z.infer<typeof nhConfigApplySchema>
export type NotificationHubConfigResult = z.infer<typeof nhConfigResultSchema>
