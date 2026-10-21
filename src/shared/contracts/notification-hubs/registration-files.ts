import { z } from 'zod'
import { nhNameSchema } from './core'
import { nhRegistrationsRequestSchema, nhRegistrationOutcomeSchema } from './registrations'
const id = z.string().uuid()
export const registrationFileExportSchema = nhRegistrationsRequestSchema.extend({
	snapshotIds: z
		.array(id)
		.min(1)
		.max(100)
		.refine((v) => new Set(v).size === v.length),
	format: z.enum(['json', 'xml']),
})
export const registrationFileEncodedSchema = z
	.object({ contentBase64: z.string().max(699052), count: z.number().int().min(1).max(100) })
	.strict()
export const registrationFileEntrySchema = z
	.object({
		id,
		registrationId: z.string().max(256).nullable(),
		kind: z.string().max(128),
		platform: z.string().max(64),
		template: z.boolean(),
		tags: z.array(z.string().max(256)).max(256),
		handle: z.string().max(4096).nullable(),
		action: z.enum(['create', 'blocked']),
		issue: z.string().max(1024).nullable(),
	})
	.strict()
export const registrationFilePreviewSchema = z
	.object({
		importId: id,
		sourceNamespace: z.string().max(253),
		sourceHub: z.string().max(265),
		destinationNamespace: z.string().max(253),
		destinationHub: nhNameSchema,
		expiresAt: z.string().max(64),
		entries: z.array(registrationFileEntrySchema).min(1).max(100),
		warnings: z.array(z.string().max(512)).max(8),
	})
	.strict()
export const registrationFileImportResultSchema = z
	.object({
		cancelled: z.boolean(),
		fileName: z.string().max(1024).optional(),
		preview: registrationFilePreviewSchema.nullable(),
	})
	.strict()
export const registrationFileInspectSchema = nhRegistrationsRequestSchema.extend({
	importId: id,
	entryId: id,
})
export const registrationFileDetailsSchema = z
	.object({
		entryId: id,
		rawXml: z.string().max(131072),
		tags: z.array(z.string().max(256)).max(256),
	})
	.strict()
export const registrationFileApplySchema = nhRegistrationsRequestSchema.extend({
	importId: id,
	entryIds: z
		.array(id)
		.min(1)
		.max(100)
		.refine((v) => new Set(v).size === v.length),
	acknowledge: z.literal(true),
})
export const registrationFileResultSchema = z
	.object({
		operationId: id,
		status: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
		steps: z
			.array(
				z
					.object({
						entryId: id,
						status: z.enum([
							'confirmed',
							'failed',
							'cancelled',
							'unknown',
							'not-attempted',
						]),
						receipt: nhRegistrationOutcomeSchema.nullable(),
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
export type RegistrationFileExport = z.infer<typeof registrationFileExportSchema>
export type RegistrationFileEncoded = z.infer<typeof registrationFileEncodedSchema>
export type RegistrationFilePreview = z.infer<typeof registrationFilePreviewSchema>
export type RegistrationFileImportResult = z.infer<typeof registrationFileImportResultSchema>
export type RegistrationFileInspect = z.infer<typeof registrationFileInspectSchema>
export type RegistrationFileDetails = z.infer<typeof registrationFileDetailsSchema>
export type RegistrationFileApply = z.infer<typeof registrationFileApplySchema>
export type RegistrationFileResult = z.infer<typeof registrationFileResultSchema>
