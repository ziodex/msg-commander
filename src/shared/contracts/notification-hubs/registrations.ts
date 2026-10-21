import { z } from 'zod'
import { nhNameSchema, nhTargetSchema } from './core'
import { authorizationKeyTypeSchema } from '../../authorization'
const id = z.string().uuid()
export const nhRegistrationsConnectSchema = z
	.object({
		id,
		profileId: id,
		hubName: nhNameSchema,
		source: z.enum(['profile', 'policy']),
		managementConnectionId: id.nullable(),
		policyTarget: nhTargetSchema.nullable(),
		keyType: authorizationKeyTypeSchema.nullable(),
	})
	.strict()
	.superRefine((v, ctx) => {
		const policy = v.source === 'policy'
		if (
			policy !== (v.managementConnectionId !== null) ||
			policy !== (v.policyTarget !== null) ||
			policy !== (v.keyType !== null) ||
			(policy &&
				(!v.policyTarget?.policyName ||
					(v.policyTarget.scope.kind === 'hub' &&
						v.policyTarget.scope.name !== v.hubName)))
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Select a Manage policy on this hub or its namespace, or use the saved SAS profile.',
			})
	})
export const nhRegistrationsRequestSchema = z.object({ id, connectionId: id }).strict()
export const nhRegistrationQuerySchema = z
	.object({
		mode: z.enum(['all', 'tag', 'handle']),
		value: z
			.string()
			.max(4096)
			.refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
		handleKind: z.enum(['any', 'apns', 'wns', 'fcm']),
		pageSize: z.number().int().min(1).max(100),
	})
	.strict()
	.superRefine((v, ctx) => {
		let valid = true
		if (v.mode === 'all') valid = v.value === '' && v.handleKind === 'any'
		else if (v.mode === 'tag')
			valid =
				v.handleKind === 'any' &&
				/^[A-Za-z0-9_@#.:~-]{1,120}$/.test(v.value) &&
				!['.', '..'].includes(v.value)
		else {
			valid = !!v.value.trim()
			if (v.handleKind === 'apns') valid &&= /^(?:[A-Fa-f0-9]{2}){1,256}$/.test(v.value)
			if (v.handleKind === 'fcm') valid &&= !/\s/.test(v.value)
			if (v.handleKind === 'wns') {
				try {
					const url = new URL(v.value)
					valid &&=
						url.protocol === 'https:' &&
						!!url.hostname &&
						!url.username &&
						!url.password &&
						!url.hash
				} catch {
					valid = false
				}
			}
		}
		if (!valid)
			ctx.addIssue({
				code: 'custom',
				message:
					'Use one exact tag (up to 120 allowed characters), an APNS hex token, a WNS HTTPS handle, or a non-empty device handle.',
			})
	})
export const nhRegistrationsQuerySchema = nhRegistrationsRequestSchema.extend({
	query: nhRegistrationQuerySchema,
	continuationToken: id.nullable(),
})
export const nhRegistrationInspectSchema = nhRegistrationsRequestSchema.extend({ snapshotId: id })
export const nhRegistrationsConnectionSchema = z
	.object({
		connectionId: id,
		profileId: id,
		namespace: z.string().max(253),
		hubName: nhNameSchema,
		source: z.enum(['profile', 'policy']),
		managementConnectionId: id.nullable(),
		connectedAt: z.string().max(64),
	})
	.strict()
export const nhRegistrationSchema = z
	.object({
		snapshotId: id,
		registrationId: z.string().min(1).max(256),
		kind: z.string().max(128),
		platform: z.string().max(64),
		template: z.boolean(),
		expirationTime: z.string().max(128).nullable(),
		tags: z.array(z.string().max(256)).max(256),
		handle: z.string().max(4096).nullable(),
	})
	.strict()
export const nhRegistrationsPageSchema = z
	.object({
		items: z.array(nhRegistrationSchema).max(100),
		continuationToken: id.nullable(),
		capturedAt: z.string().max(64),
	})
	.strict()
export const nhRegistrationDetailsSchema = z
	.object({
		registration: nhRegistrationSchema,
		capturedAt: z.string().max(64),
		etag: z.string().max(512).nullable(),
		templateBody: z.string().max(131072).nullable(),
		rawXml: z.string().max(131072),
		warning: z.string().max(512).nullable(),
	})
	.strict()
export type NotificationHubRegistrationsConnect = z.infer<typeof nhRegistrationsConnectSchema>
export type NotificationHubRegistrationsRequest = z.infer<typeof nhRegistrationsRequestSchema>
export type NotificationHubRegistrationsConnection = z.infer<typeof nhRegistrationsConnectionSchema>
export type NotificationHubRegistrationQuery = z.infer<typeof nhRegistrationQuerySchema>
export type NotificationHubRegistrationsQuery = z.infer<typeof nhRegistrationsQuerySchema>
export type NotificationHubRegistrationsPage = z.infer<typeof nhRegistrationsPageSchema>
export type NotificationHubRegistration = z.infer<typeof nhRegistrationSchema>
export type NotificationHubRegistrationInspect = z.infer<typeof nhRegistrationInspectSchema>
export type NotificationHubRegistrationDetails = z.infer<typeof nhRegistrationDetailsSchema>
export const defaultRegistrationQuery = (): NotificationHubRegistrationQuery => ({
	mode: 'all',
	value: '',
	handleKind: 'any',
	pageSize: 25,
})

export const nhRegistrationDraftSchema = z
	.object({
		rawXml: z.string().min(1).max(131072),
		tags: z
			.array(z.string().regex(/^[A-Za-z0-9_@#.:~-]{1,120}$/))
			.max(60)
			.refine((v) => new Set(v).size === v.length, 'Registration tags must be unique.'),
	})
	.strict()
export const nhRegistrationChangeSchema = nhRegistrationsRequestSchema
	.extend({
		action: z.enum(['create', 'update', 'delete']),
		snapshotId: id.nullable(),
		draft: nhRegistrationDraftSchema.nullable(),
		acknowledge: z.literal(true),
	})
	.superRefine((v, ctx) => {
		if (
			(v.action === 'create') !== (v.snapshotId === null) ||
			(v.action === 'delete') !== (v.draft === null)
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Edit/delete requires a current snapshot; create/update requires a definition.',
			})
	})
export const nhRegistrationResultSchema = nhRegistrationsRequestSchema.extend({ operationId: id })
export const nhRegistrationOutcomeSchema = z
	.object({
		operationId: id,
		action: z.enum(['create', 'update', 'delete']),
		status: z.enum(['confirmed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(1024),
		registrationId: z.string().max(256).nullable(),
		etag: z.string().max(512).nullable(),
		snapshotId: id.nullable(),
	})
	.strict()
export type NotificationHubRegistrationDraft = z.infer<typeof nhRegistrationDraftSchema>
export type NotificationHubRegistrationChange = z.infer<typeof nhRegistrationChangeSchema>
export type NotificationHubRegistrationOutcome = z.infer<typeof nhRegistrationOutcomeSchema>
export type NotificationHubRegistrationResult = z.infer<typeof nhRegistrationResultSchema>
