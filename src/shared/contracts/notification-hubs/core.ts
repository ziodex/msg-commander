import { z } from 'zod'
import {
	authorizationKeySchema,
	authorizationKeyTypeSchema,
	authorizationRightsSchema,
} from '../../authorization'
import { propertySchema } from '../../service-bus'
const id = z.string().uuid()
export const nhNameSchema = z
	.string()
	.min(1)
	.max(265)
	.regex(/^[A-Za-z][A-Za-z0-9-./_]*$/)
	.refine(
		(v) => v.split('/').every((p) => !!p && p !== '.' && p !== '..'),
		'Use non-empty hub path segments without dot traversal.',
	)
export const nhScopeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('namespace'), name: z.literal('') }).strict(),
	z.object({ kind: z.literal('hub'), name: nhNameSchema }).strict(),
])
export const nhPolicyNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9!()*._-]+$/)
	.refine((v) => v !== '.' && v !== '..')
export const nhTargetSchema = z
	.object({ scope: nhScopeSchema, policyName: nhPolicyNameSchema.nullable() })
	.strict()
export const nhManagementSchema = z
	.object({
		resourceId: z
			.string()
			.max(1024)
			.regex(
				/^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft\.NotificationHubs\/namespaces\/[a-z][a-z0-9-]{0,49}$/i,
			)
			.refine((v) => !['.', '..'].includes(v.split('/')[4])),
		tenantId: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9.-]+$/),
		clientId: id,
	})
	.strict()
export const nhConnectSchema = z
	.object({ id, profileId: id, management: nhManagementSchema })
	.strict()
export const nhRequestSchema = z.object({ id, connectionId: id }).strict()
export const nhGetSchema = nhRequestSchema.extend({ target: nhTargetSchema })
export const nhListSchema = nhRequestSchema
	.extend({
		scope: nhScopeSchema,
		kind: z.enum(['hubs', 'policies']),
		continuationToken: id.nullable(),
	})
	.refine(
		(v) => v.kind === 'policies' || v.scope.kind === 'namespace',
		'Resource lists belong to the namespace.',
	)
export const nhTtlSchema = z
	.string()
	.max(40)
	.refine((v) => {
		const m = /^(?:(\d{1,8})\.)?(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(v)
		if (!m || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59) return false
		const ticks =
			((BigInt(m[1] ?? '0') * 24n + BigInt(m[2])) * 3600n +
				BigInt(m[3]) * 60n +
				BigInt(m[4])) *
				10000000n +
			BigInt((m[5] ?? '').padEnd(7, '0'))
		return ticks > 0n && ticks <= 9223372036854775807n
	}, 'Use a positive lifetime in days.hh:mm:ss format, up to the .NET TimeSpan maximum.')
export const nhSettingsSchema = z
	.object({
		registrationTtl: nhTtlSchema,
		tags: z
			.array(
				z
					.object({
						name: z
							.string()
							.min(1)
							.max(512)
							.refine(
								(v) => !!v.trim() && !/[\x00-\x1f\x7f-\x9f<>%&\\?/]/.test(v),
								'Use an Azure tag name without control or reserved characters.',
							),
						value: z.string().max(256),
					})
					.strict(),
			)
			.max(50)
			.refine(
				(v) => new Set(v.map((t) => t.name.toLowerCase())).size === v.length,
				'Tag names must be distinct.',
			),
	})
	.strict()
export const nhDetailsSchema = z
	.object({
		target: nhTargetSchema,
		revision: z.string().regex(/^[A-F0-9]{64}$/),
		settings: nhSettingsSchema.nullable(),
		rights: authorizationRightsSchema.nullable(),
		properties: z.array(propertySchema).max(32),
		warning: z.string().max(1024).nullable(),
	})
	.strict()
export const nhItemSchema = z
	.object({
		target: nhTargetSchema,
		registrationTtl: z.string().max(40).nullable(),
		rights: authorizationRightsSchema.nullable(),
	})
	.strict()
export const nhPageSchema = z
	.object({ items: z.array(nhItemSchema).max(250), continuationToken: id.nullable() })
	.strict()
export const nhConnectionSchema = z
	.object({
		connectionId: id,
		profileId: id,
		namespace: z.string().max(253),
		resourceId: z.string().max(1024),
		connectedAt: z.string().max(64),
		location: z.string().max(128),
	})
	.strict()
export const nhChangeSchema = nhGetSchema
	.extend({
		action: z.enum(['create', 'update', 'delete', 'regenerate']),
		expectedRevision: nhDetailsSchema.shape.revision.nullable(),
		settings: nhSettingsSchema.nullable(),
		rights: authorizationRightsSchema.nullable(),
		keyType: authorizationKeyTypeSchema.nullable(),
		acknowledged: z.literal(true),
	})
	.superRefine((v, ctx) => {
		const editing = v.action === 'create' || v.action === 'update',
			policy = v.target.policyName !== null
		if (
			(!policy && v.target.scope.kind === 'namespace') ||
			(v.action === 'create') !== (v.expectedRevision === null) ||
			(editing && !policy) !== (v.settings !== null) ||
			(editing && policy) !== (v.rights !== null) ||
			(v.action === 'regenerate') !== (v.keyType !== null) ||
			(v.action === 'regenerate' && !policy)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Use the settings for the selected Notification Hubs resource and action.',
			})
	})
export const nhOutcomeSchema = z
	.object({
		operationId: id,
		target: nhTargetSchema,
		action: z.enum(['create', 'update', 'delete', 'regenerate', 'credentials']),
		status: z.enum(['confirmed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
	})
	.strict()
export const nhResultSchema = nhRequestSchema.extend({ operationId: id })
export const nhKeySchema = nhGetSchema
	.extend({ keyType: authorizationKeyTypeSchema })
	.refine((v) => v.target.policyName !== null)
export const nhCopyKeySchema = nhKeySchema.safeExtend({
	format: z.enum(['key', 'connectionString']),
})
export { authorizationKeySchema as nhKeyResultSchema }
export type NotificationHubScope = z.infer<typeof nhScopeSchema>
export type NotificationHubTarget = z.infer<typeof nhTargetSchema>
export type NotificationHubManagement = z.infer<typeof nhManagementSchema>
export type NotificationHubConnect = z.infer<typeof nhConnectSchema>
export type NotificationHubRequest = z.infer<typeof nhRequestSchema>
export type NotificationHubGet = z.infer<typeof nhGetSchema>
export type NotificationHubList = z.infer<typeof nhListSchema>
export type NotificationHubSettings = z.infer<typeof nhSettingsSchema>
export type NotificationHubDetails = z.infer<typeof nhDetailsSchema>
export type NotificationHubPage = z.infer<typeof nhPageSchema>
export type NotificationHubConnection = z.infer<typeof nhConnectionSchema>
export type NotificationHubChange = z.infer<typeof nhChangeSchema>
export type NotificationHubOutcome = z.infer<typeof nhOutcomeSchema>
export type NotificationHubResult = z.infer<typeof nhResultSchema>
export type NotificationHubKey = z.infer<typeof nhKeySchema>
export type NotificationHubCopyKey = z.infer<typeof nhCopyKeySchema>
export const nhNamespace: NotificationHubScope = { kind: 'namespace', name: '' }
export function nhPath(target: NotificationHubTarget) {
	return `${target.scope.kind === 'namespace' ? 'namespace' : `${target.scope.kind}/${target.scope.name}`}${target.policyName ? `/policies/${target.policyName}` : ''}`
}
export function defaultNotificationHubSettings(): NotificationHubSettings {
	return { registrationTtl: '10675199.02:48:05.4775807', tags: [] }
}
