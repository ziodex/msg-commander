import { z } from 'zod'

const id = z.string().uuid()
export const authorizationTargetSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('namespace') }).strict(),
	z.object({ kind: z.literal('queue'), name: z.string().min(1).max(260) }).strict(),
	z.object({ kind: z.literal('topic'), name: z.string().min(1).max(260) }).strict(),
])
export const authorizationContextSchema = z
	.object({
		resourceId: z
			.string()
			.max(512)
			.regex(
				/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[\w().-]{1,90}\/providers\/Microsoft\.ServiceBus\/namespaces\/[a-z0-9-]{6,50}$/i,
			),
		tenantId: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[a-zA-Z0-9.-]+$/),
		clientId: id,
	})
	.strict()
export const authorizationSessionSchema = z
	.object({ authorizationId: id, resourceId: z.string().max(512) })
	.strict()
export const authorizationRightsSchema = z
	.array(z.enum(['Listen', 'Send', 'Manage']))
	.min(1)
	.max(3)
	.refine((rights) => new Set(rights).size === rights.length, 'Rights must be unique.')
	.refine(
		(rights) =>
			!rights.includes('Manage') || (rights.includes('Listen') && rights.includes('Send')),
		'Manage requires Send and Listen.',
	)
const name = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/)
const revision = z.string().regex(/^[A-F0-9]{64}$/)
export const authorizationRuleSchema = z
	.object({ name, rights: authorizationRightsSchema, revision })
	.strict()
export const authorizationPageSchema = z
	.object({ items: z.array(authorizationRuleSchema).max(100) })
	.strict()
export const authorizationKeySchema = z
	.object({ key: z.string().min(1).max(4096), connectionString: z.string().min(1).max(8192) })
	.strict()
const base = z.object({ id, connectionId: id }).strict()
export const connectAuthorizationSchema = base.extend({ context: authorizationContextSchema })
export const listAuthorizationSchema = base.extend({
	authorizationId: id,
	target: authorizationTargetSchema,
})
export const getAuthorizationSchema = listAuthorizationSchema.extend({ name })
export const createAuthorizationSchema = getAuthorizationSchema.extend({
	rights: authorizationRightsSchema,
})
export const updateAuthorizationSchema = createAuthorizationSchema.extend({
	expectedRevision: revision,
	confirmation: z.string().max(1024),
})
export const deleteAuthorizationSchema = getAuthorizationSchema.extend({
	expectedRevision: revision,
	confirmation: z.string().max(1024),
})
export const authorizationKeyTypeSchema = z.enum(['PrimaryKey', 'SecondaryKey'])
export const getAuthorizationKeySchema = getAuthorizationSchema.extend({
	keyType: authorizationKeyTypeSchema,
})
export const copyAuthorizationKeySchema = getAuthorizationKeySchema.extend({
	format: z.enum(['key', 'connectionString']),
})
export const regenerateAuthorizationSchema = deleteAuthorizationSchema.extend({
	keyType: authorizationKeyTypeSchema,
})
export type AuthorizationTarget = z.infer<typeof authorizationTargetSchema>
export type AuthorizationContext = z.infer<typeof authorizationContextSchema>
export type AuthorizationSession = z.infer<typeof authorizationSessionSchema>
export type AuthorizationRule = z.infer<typeof authorizationRuleSchema>
export type AuthorizationPage = z.infer<typeof authorizationPageSchema>
export type AuthorizationKey = z.infer<typeof authorizationKeySchema>
export type AuthorizationRight = z.infer<typeof authorizationRightsSchema>[number]
export type AuthorizationKeyType = z.infer<typeof authorizationKeyTypeSchema>
export type ConnectAuthorizationRequest = z.infer<typeof connectAuthorizationSchema>
export type ListAuthorizationRequest = z.infer<typeof listAuthorizationSchema>
export type GetAuthorizationRequest = z.infer<typeof getAuthorizationSchema>
export type CreateAuthorizationRequest = z.infer<typeof createAuthorizationSchema>
export type UpdateAuthorizationRequest = z.infer<typeof updateAuthorizationSchema>
export type DeleteAuthorizationRequest = z.infer<typeof deleteAuthorizationSchema>
export type GetAuthorizationKeyRequest = z.infer<typeof getAuthorizationKeySchema>
export type CopyAuthorizationKeyRequest = z.infer<typeof copyAuthorizationKeySchema>
export type RegenerateAuthorizationRequest = z.infer<typeof regenerateAuthorizationSchema>
export function authorizationPath(resourceId: string, target: AuthorizationTarget, rule: string) {
	return `${resourceId}${target.kind === 'namespace' ? '' : `/${target.kind === 'queue' ? 'queues' : 'topics'}/${target.name}`}/authorizationRules/${rule}`
}
export function authorizationConfirmation(
	action: 'update' | 'delete' | 'regenerate',
	resourceId: string,
	target: AuthorizationTarget,
	rule: string,
	keyType?: AuthorizationKeyType,
) {
	return `${action.toUpperCase()} ${authorizationPath(resourceId, target, rule)}${action === 'regenerate' ? ` ${keyType}` : ''}`
}
