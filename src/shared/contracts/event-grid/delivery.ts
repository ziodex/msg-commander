import { z } from 'zod'
const arm = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(v) =>
			/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\//i.test(v) &&
			!v.split('/').some((p) => p === '.' || p === '..' || /[%?#\x00-\x20]/.test(p)),
		'Use a valid ARM resource ID.',
	)
export const eventGridIdentitySchema = z
	.object({
		type: z.enum(['None', 'SystemAssigned', 'UserAssigned']),
		userAssignedIdentity: arm.nullable(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (
			v.type === 'UserAssigned'
				? !v.userAssignedIdentity ||
					!/\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[^/]+$/i.test(
						v.userAssignedIdentity,
					)
				: v.userAssignedIdentity !== null
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Choose a namespace identity and its ARM resource ID when user-assigned.',
			})
	})
const headerName = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
	.refine(
		(v) =>
			!/^(aeg-|x-ms-|content-|host$|connection$|transfer-encoding$|cookie$|set-cookie$|accept$|user-agent$)/i.test(
				v,
			),
		'This header is reserved.',
	)
export const eventGridHeaderSchema = z.discriminatedUnion('type', [
	z
		.object({
			name: headerName,
			type: z.literal('Static'),
			value: z
				.string()
				.max(4096)
				.refine(
					(v) => new TextEncoder().encode(v).length <= 4096 && !/[\x00-\x1f\x7f]/.test(v),
					'Header values must be at most 4096 UTF-8 bytes without control characters.',
				),
			isSecret: z.boolean(),
		})
		.strict(),
	z
		.object({
			name: headerName,
			type: z.literal('Dynamic'),
			sourceField: z
				.string()
				.min(1)
				.max(1024)
				.refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
		})
		.strict(),
])
export const eventGridDeliverySchema = z
	.object({
		// null means preserve the privately held configuration; [] explicitly clears headers.
		identity: eventGridIdentitySchema.nullable(),
		headers: z.array(eventGridHeaderSchema).max(10).nullable(),
		webhookAuthentication: z
			.object({
				tenantId: z
					.string()
					.regex(
						/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
						'Use a tenant GUID.',
					),
				applicationIdOrUri: z
					.string()
					.min(1)
					.max(1024)
					.refine((v) => !/[\x00-\x20\x7f]/.test(v)),
			})
			.strict()
			.nullable()
			.optional(),
		deadLetter: z
			.discriminatedUnion('action', [
				z
					.object({
						action: z.literal('clear'),
						resourceId: z.null(),
						containerName: z.null(),
						identity: z.null(),
					})
					.strict(),
				z
					.object({
						action: z.literal('set'),
						resourceId: arm.refine(
							(v) =>
								/\/providers\/Microsoft.Storage\/storageAccounts\/[a-z0-9]{3,24}$/i.test(
									v,
								),
							'Use a storage account ARM resource ID.',
						),
						containerName: z
							.string()
							.regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
							.refine((v) => !v.includes('--'), 'Use a valid blob container name.'),
						identity: eventGridIdentitySchema.refine(
							(v) => v.type !== 'None',
							'Dead-lettering requires a namespace managed identity.',
						),
					})
					.strict(),
			])
			.nullable(),
	})
	.strict()
	.superRefine((v, ctx) => {
		const names = v.headers?.map((h) => h.name.toLowerCase()) ?? []
		if (new Set(names).size !== names.length)
			ctx.addIssue({ code: 'custom', message: 'Delivery header names must be unique.' })
	})
export const eventGridDeliveryDetailsSchema = z
	.object({
		destinationType: z.string().max(100).nullable(),
		resourceId: z.string().max(1024).nullable(),
		identity: eventGridIdentitySchema.nullable(),
		headers: z
			.array(
				z
					.object({
						name: z.string().max(64),
						type: z.string().max(64),
						isSecret: z.boolean(),
					})
					.strict(),
			)
			.max(10),
		deadLetter: z
			.object({
				resourceId: z.string().max(1024).nullable(),
				containerName: z.string().max(63).nullable(),
				identity: eventGridIdentitySchema.nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict()
export type EventGridDelivery = z.infer<typeof eventGridDeliverySchema>
export type EventGridIdentity = z.infer<typeof eventGridIdentitySchema>
export type EventGridHeader = z.infer<typeof eventGridHeaderSchema>
export type EventGridDeliveryDetails = z.infer<typeof eventGridDeliveryDetailsSchema>
