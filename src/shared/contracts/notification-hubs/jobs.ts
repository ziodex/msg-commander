import { z } from 'zod'
import { nhRegistrationsRequestSchema, nhRegistrationResultSchema } from './registrations'
import { nhNameSchema } from './core'
export const jobTypes = [
	'ExportRegistrations',
	'ImportCreateRegistrations',
	'ImportUpdateRegistrations',
	'ImportDeleteRegistrations',
	'ImportUpsertRegistrations',
] as const
export const jobLabels: Record<(typeof jobTypes)[number], string> = {
	ExportRegistrations: 'Export all registrations',
	ImportCreateRegistrations: 'Create registrations from Storage',
	ImportUpdateRegistrations: 'Update registrations from Storage',
	ImportDeleteRegistrations: 'Delete registrations from Storage',
	ImportUpsertRegistrations: 'Create or update registrations from Storage',
}
export function storageSasError(value: string, output: boolean): string | undefined {
	const message =
		'Use an unexpired HTTPS Azure Blob SAS URL: an output container with write/list permissions, or a readable input blob.'
	try {
		if (!value || value.length > 8192 || /\s|\\/.test(value)) return message
		const url = new URL(value)
		const path = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
		const params = url.searchParams
		const keys = [...params.keys()].map((key) => key.toLowerCase())
		if (
			url.protocol !== 'https:' ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
			!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(path[0]) ||
			path[0].includes('--') ||
			(output ? path.length !== 1 : path.length < 2) ||
			path.some((p) => !p || ['.', '..'].includes(decodeURIComponent(p))) ||
			new Set(keys).size !== keys.length ||
			!params.get('sig')?.trim() ||
			!params.get('sv')?.trim() ||
			!Number.isFinite(Date.parse(params.get('se') ?? '')) ||
			Date.parse(params.get('se')!) <= Date.now() + 60_000 ||
			(output
				? !params.get('sp')?.includes('w') || !params.get('sp')?.includes('l')
				: !params.get('sp')?.includes('r')) ||
			(output ? params.get('sr') !== 'c' : !['b', 'c'].includes(params.get('sr') ?? '')) ||
			(params.has('spr') && params.get('spr') !== 'https') ||
			(params.has('st') &&
				(!Number.isFinite(Date.parse(params.get('st')!)) ||
					Date.parse(params.get('st')!) > Date.now()))
		)
			return message
	} catch {
		return message
	}
}
export const nhJobDraftSchema = z
	.object({
		type: z.enum(jobTypes),
		importFileUri: z.string().max(8192).nullable(),
		outputContainerUri: z.string().min(1).max(8192),
	})
	.strict()
	.superRefine((value, context) => {
		if ((value.type === 'ExportRegistrations') !== (value.importFileUri === null))
			context.addIssue({
				code: 'custom',
				message:
					'Export needs only output; import needs an input blob and output container.',
			})
		const issue =
			storageSasError(value.outputContainerUri, true) ??
			(value.importFileUri === null ? undefined : storageSasError(value.importFileUri, false))
		if (issue) context.addIssue({ code: 'custom', message: issue })
	})
const safeLocation = z
	.string()
	.max(8192)
	.refine((value) => {
		try {
			const url = new URL(value)
			return (
				url.protocol === 'https:' &&
				!url.port &&
				!url.username &&
				!url.password &&
				!url.search &&
				!url.hash &&
				/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)
			)
		} catch {
			return false
		}
	})
export const nhJobSchema = z
	.object({
		jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		type: z.enum([...jobTypes, 'Unknown']),
		status: z.enum(['Started', 'Running', 'Completed', 'Failed', 'Unknown']),
		progress: z.number().min(0).max(100).nullable(),
		createdAt: z.string().max(64).nullable(),
		updatedAt: z.string().max(64).nullable(),
		outputContainerUri: safeLocation.nullable(),
		importFileUri: safeLocation.nullable(),
		outputFile: safeLocation.nullable(),
		failuresFile: safeLocation.nullable(),
		hasFailure: z.boolean(),
	})
	.strict()
export const nhJobsPageSchema = z
	.object({
		items: z.array(nhJobSchema).max(100),
		capturedAt: z.string().max(64),
		moreAvailable: z.boolean(),
	})
	.strict()
export const nhJobReviewSchema = z
	.object({
		reviewId: z.string().uuid(),
		namespace: z.string().max(253),
		hubName: nhNameSchema,
		type: z.enum(jobTypes),
		importFileUri: safeLocation.nullable(),
		outputContainerUri: safeLocation,
		expiresAt: z.string().max(64),
		warnings: z.array(z.string().max(1024)).max(8),
	})
	.strict()
export const nhJobPreviewSchema = nhRegistrationsRequestSchema.extend({ draft: nhJobDraftSchema })
export const nhJobSubmitSchema = nhRegistrationsRequestSchema.extend({
	reviewId: z.string().uuid(),
	acknowledge: z.literal(true),
})
export const nhJobGetSchema = nhRegistrationsRequestSchema.extend({
	jobId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
})
export const nhJobOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		status: z.enum(['accepted', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(1024),
		job: nhJobSchema.nullable(),
	})
	.strict()
export const nhJobResultSchema = nhRegistrationResultSchema
export type NotificationHubJobDraft = z.infer<typeof nhJobDraftSchema>
export type NotificationHubJob = z.infer<typeof nhJobSchema>
export type NotificationHubJobsPage = z.infer<typeof nhJobsPageSchema>
export type NotificationHubJobReview = z.infer<typeof nhJobReviewSchema>
export type NotificationHubJobPreview = z.infer<typeof nhJobPreviewSchema>
export type NotificationHubJobSubmit = z.infer<typeof nhJobSubmitSchema>
export type NotificationHubJobGet = z.infer<typeof nhJobGetSchema>
export type NotificationHubJobOutcome = z.infer<typeof nhJobOutcomeSchema>
