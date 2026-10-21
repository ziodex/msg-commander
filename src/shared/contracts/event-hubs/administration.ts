import { z } from 'zod'
import { consumerGroupSchema, eventHubNameSchema, eventHubsRequestSchema } from './core'
import {
	authorizationKeySchema,
	authorizationKeyTypeSchema,
	authorizationRightsSchema,
	authorizationRuleSchema,
} from '../../authorization'
import { propertySchema } from '../../service-bus'
const hubScope = z.union([z.literal(''), eventHubNameSchema])
const revision = z.string().regex(/^[A-F0-9]{64}$/)
export const eventAdminTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('hub'), name: eventHubNameSchema }).strict(),
	z
		.object({
			kind: z.literal('group'),
			hubName: eventHubNameSchema,
			name: consumerGroupSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal('policy'),
			hubName: hubScope,
			name: authorizationRuleSchema.shape.name,
		})
		.strict(),
])
const storageId = z
	.string()
	.max(1024)
	.regex(
		/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft.Storage\/storageAccounts\/[a-z0-9]{3,24}$/i,
	)
const identityId = z
	.string()
	.max(1024)
	.regex(
		/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_-]{1,128}$/i,
	)
export const eventCaptureSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('preserve') }).strict(),
	z.object({ mode: z.literal('disabled') }).strict(),
	z
		.object({
			mode: z.literal('configure'),
			intervalSeconds: z.number().int().min(60).max(900),
			sizeBytes: z.number().int().min(10485760).max(524288000),
			skipEmpty: z.boolean(),
			storageAccountResourceId: storageId,
			blobContainer: z
				.string()
				.min(3)
				.max(63)
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			archiveNameFormat: z.string().min(1).max(1024),
			identity: z.enum(['none', 'SystemAssigned', 'UserAssigned']),
			userAssignedIdentity: z.union([z.literal(''), identityId]),
		})
		.strict()
		.refine(
			(v) =>
				v.identity === 'UserAssigned' ? !!v.userAssignedIdentity : !v.userAssignedIdentity,
			'Supply an identity resource ID only for UserAssigned capture.',
		)
		.refine(
			(v) =>
				[
					'Namespace',
					'EventHub',
					'PartitionId',
					'Year',
					'Month',
					'Day',
					'Hour',
					'Minute',
					'Second',
				].every((x) => v.archiveNameFormat.includes(`{${x}}`)),
			'Include every required archive path placeholder.',
		),
])
export const eventHubSettingsSchema = z
	.object({
		partitionCount: z.number().int().min(1).max(1024),
		status: z.enum(['Active', 'Disabled', 'SendDisabled', 'ReceiveDisabled']),
		cleanupPolicy: z.enum(['Delete', 'Compact', 'DeleteOrCompact']),
		retentionHours: z.number().int().min(1).max(2160).nullable(),
		tombstoneHours: z.number().int().min(1).max(2160).nullable(),
		minCompactionLagMinutes: z.number().int().min(0).max(2147483647).nullable(),
		userMetadata: z.string().max(1024),
		capture: eventCaptureSchema,
	})
	.strict()
	.refine(
		(v) =>
			v.cleanupPolicy === 'Compact' ? v.retentionHours === null : v.retentionHours !== null,
		'Set retention hours for a delete policy; compact-only retention is infinite.',
	)
	.refine(
		(v) =>
			v.cleanupPolicy !== 'Delete' ||
			(v.tombstoneHours === null && v.minCompactionLagMinutes === null),
		'Compaction settings only apply to compacted hubs.',
	)
export const eventAdminContextSchema = z
	.object({
		resourceId: z.string().max(1024),
		tier: z.string().max(64),
		localAuthDisabled: z.boolean(),
	})
	.strict()
export const eventAdminGetSchema = eventHubsRequestSchema.extend({ target: eventAdminTargetSchema })
export const eventAdminDetailsSchema = z
	.object({
		target: eventAdminTargetSchema,
		revision,
		hub: eventHubSettingsSchema.nullable(),
		userMetadata: z.string().max(1024).nullable(),
		rights: authorizationRightsSchema.nullable(),
		properties: z.array(propertySchema).max(64),
		warning: z.string().max(2048).nullable(),
	})
	.strict()
export const eventPolicyListSchema = eventHubsRequestSchema.extend({
	hubName: hubScope,
	continuationToken: z.string().uuid().nullable(),
})
export const eventPolicyPageSchema = z
	.object({
		items: z.array(authorizationRuleSchema).max(100),
		continuationToken: z.string().uuid().nullable(),
	})
	.strict()
export const eventAdminChangeSchema = eventAdminGetSchema
	.extend({
		action: z.enum(['create', 'update', 'delete', 'regenerate']),
		expectedRevision: revision.nullable(),
		settings: eventHubSettingsSchema.nullable(),
		userMetadata: z.string().max(1024).nullable(),
		rights: authorizationRightsSchema.nullable(),
		keyType: authorizationKeyTypeSchema.nullable(),
		acknowledged: z.literal(true),
		confirmation: z.string().max(1024),
	})
	.superRefine((v, ctx) => {
		const edit = v.action === 'create' || v.action === 'update'
		if (
			(v.action === 'create') !== (v.expectedRevision === null) ||
			(edit && v.target.kind === 'hub') !== (v.settings !== null) ||
			(edit && v.target.kind === 'group') !== (v.userMetadata !== null) ||
			(edit && v.target.kind === 'policy') !== (v.rights !== null) ||
			(v.action === 'regenerate') !== (v.keyType !== null) ||
			(v.action === 'regenerate' && v.target.kind !== 'policy')
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Use only the settings for the selected action and resource.',
			})
		if (
			(v.action === 'delete' || v.action === 'regenerate') &&
			v.confirmation !== eventAdminConfirmation(v.action, v.target, v.keyType)
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Enter the confirmation shown for this resource.',
			})
		if (
			v.target.kind === 'group' &&
			v.target.name === '$Default' &&
			(v.action === 'create' || v.action === 'delete')
		)
			ctx.addIssue({
				code: 'custom',
				message: 'The built-in $Default group cannot be created or deleted here.',
			})
	})
export const eventAdminOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		target: eventAdminTargetSchema,
		action: z.enum(['create', 'update', 'delete', 'regenerate']),
		status: z.enum(['confirmed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
	})
	.strict()
export const eventAdminResultSchema = eventHubsRequestSchema.extend({
	operationId: z.string().uuid(),
})
export const eventPolicyKeyRequestSchema = eventHubsRequestSchema.extend({
	target: eventAdminTargetSchema.options[2],
	keyType: authorizationKeyTypeSchema,
})
export const eventPolicyCopyRequestSchema = eventPolicyKeyRequestSchema.extend({
	format: z.enum(['key', 'connectionString']),
})
export { authorizationKeySchema as eventPolicyKeySchema }
export type EventAdminTarget = z.infer<typeof eventAdminTargetSchema>
export type EventHubSettings = z.infer<typeof eventHubSettingsSchema>
export type EventCapture = z.infer<typeof eventCaptureSchema>
export type EventAdminContext = z.infer<typeof eventAdminContextSchema>
export type EventAdminGet = z.infer<typeof eventAdminGetSchema>
export type EventAdminDetails = z.infer<typeof eventAdminDetailsSchema>
export type EventPolicyList = z.infer<typeof eventPolicyListSchema>
export type EventPolicyPage = z.infer<typeof eventPolicyPageSchema>
export type EventAdminChange = z.infer<typeof eventAdminChangeSchema>
export type EventAdminOutcome = z.infer<typeof eventAdminOutcomeSchema>
export type EventAdminResult = z.infer<typeof eventAdminResultSchema>
export type EventPolicyKeyRequest = z.infer<typeof eventPolicyKeyRequestSchema>
export type EventPolicyCopyRequest = z.infer<typeof eventPolicyCopyRequestSchema>
export function eventAdminPath(target: EventAdminTarget) {
	return target.kind === 'hub'
		? target.name
		: target.kind === 'group'
			? `${target.hubName}/consumerGroups/${target.name}`
			: `${target.hubName || 'namespace'}/authorizationRules/${target.name}`
}
export function eventAdminConfirmation(
	action: string,
	target: EventAdminTarget,
	keyType: string | null,
) {
	return `${action.toUpperCase()} ${eventAdminPath(target)}${action === 'regenerate' ? ` ${keyType}` : ''}`
}
export const defaultEventHubSettings = (): EventHubSettings => ({
	partitionCount: 2,
	status: 'Active',
	cleanupPolicy: 'Delete',
	retentionHours: 24,
	tombstoneHours: null,
	minCompactionLagMinutes: null,
	userMetadata: '',
	capture: { mode: 'preserve' },
})
