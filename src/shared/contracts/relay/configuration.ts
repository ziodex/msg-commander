import { z } from 'zod'
import { authorizationRightsSchema } from '../../authorization'
import {
	relayOutcomeSchema,
	relayRequestSchema,
	relayScopeSchema,
	relaySettingsSchema,
	relayTargetSchema,
} from './core'
export const relayConfigFormatSchema = z.literal('json')
export const relayConfigExportSchema = relayRequestSchema.extend({
	scope: relayScopeSchema,
	format: relayConfigFormatSchema,
})
export const relayConfigEncodedSchema = z
	.object({
		contentBase64: z.string().max(349528),
		count: z.number().int().min(1).max(100),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
export const relayConfigEntrySchema = z
	.object({
		id: z.string().uuid(),
		target: relayTargetSchema,
		action: z.enum(['create', 'update', 'blocked']),
		settings: relaySettingsSchema.nullable(),
		rights: authorizationRightsSchema.nullable(),
		currentSettings: relaySettingsSchema.nullable(),
		currentRights: authorizationRightsSchema.nullable(),
		issue: z.string().max(1024).nullable(),
	})
	.strict()
export const relayConfigPreviewSchema = z
	.object({
		importId: z.string().uuid(),
		sourceNamespace: z.string().max(253),
		destinationNamespace: z.string().max(253),
		expiresAt: z.string().max(64),
		entries: z.array(relayConfigEntrySchema).min(1).max(100),
		warnings: z.array(z.string().max(512)).max(100),
	})
	.strict()
export const relayConfigImportResultSchema = z
	.object({
		cancelled: z.boolean(),
		fileName: z.string().max(1024).optional(),
		preview: relayConfigPreviewSchema.nullable(),
	})
	.strict()
export const relayConfigApplySchema = relayRequestSchema
	.extend({
		importId: z.string().uuid(),
		entryIds: z.array(z.string().uuid()).min(1).max(100),
		acknowledged: z.literal(true),
	})
	.refine((v) => new Set(v.entryIds).size === v.entryIds.length)
export const relayConfigResultSchema = z
	.object({
		operationId: z.string().uuid(),
		status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
		steps: z
			.array(
				z
					.object({
						target: relayTargetSchema,
						status: z.enum([
							'confirmed',
							'failed',
							'cancelled',
							'unknown',
							'not-attempted',
						]),
						receipt: relayOutcomeSchema.nullable(),
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
export type RelayConfigExport = z.infer<typeof relayConfigExportSchema>
export type RelayConfigEncoded = z.infer<typeof relayConfigEncodedSchema>
export type RelayConfigPreview = z.infer<typeof relayConfigPreviewSchema>
export type RelayConfigImportResult = z.infer<typeof relayConfigImportResultSchema>
export type RelayConfigApply = z.infer<typeof relayConfigApplySchema>
export type RelayConfigResult = z.infer<typeof relayConfigResultSchema>
