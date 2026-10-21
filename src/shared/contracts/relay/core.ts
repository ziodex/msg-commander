import { z } from 'zod'
import {
	authorizationKeySchema,
	authorizationKeyTypeSchema,
	authorizationRightsSchema,
} from '../../authorization'
import { propertySchema } from '../../service-bus'
const id = z.string().uuid()
// Slash-delimited Relay names are supported; URL syntax and dot traversal are not.
export const relayNameSchema = z
	.string()
	.min(1)
	.max(260)
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/)
	.refine(
		(v) => v.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'),
		'Use non-empty Relay path segments without dot traversal.',
	)
export const relayScopeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('namespace'), name: z.literal('') }).strict(),
	z.object({ kind: z.literal('hybrid'), name: relayNameSchema }).strict(),
	z.object({ kind: z.literal('wcf'), name: relayNameSchema }).strict(),
])
export const relayTargetSchema = z
	.object({
		scope: relayScopeSchema,
		policyName: z
			.string()
			.min(1)
			.max(50)
			.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
			.nullable(),
	})
	.strict()
export const relayManagementSchema = z
	.object({
		resourceId: z
			.string()
			.max(1024)
			.regex(
				/^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft\.Relay\/namespaces\/[a-z][a-z0-9-]{4,48}[a-z0-9]$/i,
			),
		tenantId: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9.-]+$/),
		clientId: id,
	})
	.strict()
export const relayConnectSchema = z
	.object({ id, profileId: id, management: relayManagementSchema })
	.strict()
export const relayRequestSchema = z.object({ id, connectionId: id }).strict()
export const relayGetSchema = relayRequestSchema.extend({ target: relayTargetSchema })
export const relayListSchema = relayRequestSchema
	.extend({
		scope: relayScopeSchema,
		kind: z.enum(['hybrid', 'wcf', 'policies']),
		continuationToken: id.nullable(),
	})
	.refine(
		(v) => v.kind === 'policies' || v.scope.kind === 'namespace',
		'Resource lists belong to the namespace.',
	)
export const relaySettingsSchema = z
	.object({
		userMetadata: z.string().max(1024),
		requiresClientAuthorization: z.boolean(),
		relayType: z.enum(['Http', 'NetTcp']).nullable(),
		requiresTransportSecurity: z.boolean().nullable(),
	})
	.strict()
export const relayDetailsSchema = z
	.object({
		target: relayTargetSchema,
		revision: z.string().regex(/^[A-F0-9]{64}$/),
		settings: relaySettingsSchema.nullable(),
		rights: authorizationRightsSchema.nullable(),
		properties: z.array(propertySchema).max(32),
		warning: z.string().max(1024).nullable(),
	})
	.strict()
export const relayItemSchema = z
	.object({
		target: relayTargetSchema,
		listenerCount: z.number().int().nonnegative().nullable(),
		requiresClientAuthorization: z.boolean().nullable(),
		relayType: z.string().max(64).nullable(),
		rights: authorizationRightsSchema.nullable(),
	})
	.strict()
export const relayPageSchema = z
	.object({ items: z.array(relayItemSchema).max(250), continuationToken: id.nullable() })
	.strict()
export const relayConnectionSchema = z
	.object({
		connectionId: id,
		profileId: id,
		namespace: z.string().max(253),
		resourceId: z.string().max(1024),
		connectedAt: z.string().max(64),
		location: z.string().max(128),
	})
	.strict()
export const relayChangeSchema = relayGetSchema
	.extend({
		action: z.enum(['create', 'update', 'delete', 'regenerate']),
		expectedRevision: relayDetailsSchema.shape.revision.nullable(),
		settings: relaySettingsSchema.nullable(),
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
			(v.action === 'regenerate' && !policy) ||
			(v.settings &&
				((v.target.scope.kind === 'wcf') !== (v.settings.relayType !== null) ||
					(v.target.scope.kind === 'wcf') !==
						(v.settings.requiresTransportSecurity !== null)))
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Use the settings for the selected Relay resource and action.',
			})
	})
export const relayOutcomeSchema = z
	.object({
		operationId: id,
		target: relayTargetSchema,
		action: z.enum(['create', 'update', 'delete', 'regenerate']),
		status: z.enum(['confirmed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
	})
	.strict()
export const relayResultSchema = relayRequestSchema.extend({ operationId: id })
export const relayKeySchema = relayGetSchema
	.extend({ keyType: authorizationKeyTypeSchema })
	.refine((v) => v.target.policyName !== null)
export const relayCopyKeySchema = relayKeySchema.safeExtend({
	format: z.enum(['key', 'connectionString']),
})
export const relayCopyEndpointSchema = relayGetSchema
	.extend({ scheme: z.enum(['https', 'sb']) })
	.refine((v) => v.target.policyName === null && v.target.scope.kind !== 'namespace')
export { authorizationKeySchema as relayKeyResultSchema }
export type RelayScope = z.infer<typeof relayScopeSchema>
export type RelayTarget = z.infer<typeof relayTargetSchema>
export type RelayManagement = z.infer<typeof relayManagementSchema>
export type RelayConnect = z.infer<typeof relayConnectSchema>
export type RelayRequest = z.infer<typeof relayRequestSchema>
export type RelayGet = z.infer<typeof relayGetSchema>
export type RelayList = z.infer<typeof relayListSchema>
export type RelaySettings = z.infer<typeof relaySettingsSchema>
export type RelayDetails = z.infer<typeof relayDetailsSchema>
export type RelayPage = z.infer<typeof relayPageSchema>
export type RelayConnection = z.infer<typeof relayConnectionSchema>
export type RelayChange = z.infer<typeof relayChangeSchema>
export type RelayOutcome = z.infer<typeof relayOutcomeSchema>
export type RelayResult = z.infer<typeof relayResultSchema>
export type RelayKey = z.infer<typeof relayKeySchema>
export type RelayCopyKey = z.infer<typeof relayCopyKeySchema>
export type RelayCopyEndpoint = z.infer<typeof relayCopyEndpointSchema>
export const relayNamespace: RelayScope = { kind: 'namespace', name: '' }
export function relayPath(target: RelayTarget) {
	return `${target.scope.kind === 'namespace' ? 'namespace' : `${target.scope.kind}/${target.scope.name}`}${target.policyName ? `/policies/${target.policyName}` : ''}`
}
export function defaultRelaySettings(kind: 'hybrid' | 'wcf'): RelaySettings {
	return {
		userMetadata: '',
		requiresClientAuthorization: true,
		relayType: kind === 'wcf' ? 'Http' : null,
		requiresTransportSecurity: kind === 'wcf' ? true : null,
	}
}
