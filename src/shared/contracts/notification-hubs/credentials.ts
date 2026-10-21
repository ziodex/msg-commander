import { z } from 'zod'
import { nhGetSchema, nhDetailsSchema } from './core'
export const credentialProviderSchema = z.enum([
	'apns-token',
	'apns-certificate',
	'fcm-v1',
	'wns',
	'adm',
	'baidu',
	'mpns-certificate',
	'browser',
	'xiaomi',
	'gcm-legacy',
])
export const credentialGetSchema = nhGetSchema
	.extend({ provider: credentialProviderSchema })
	.refine((v) => v.target.scope.kind === 'hub' && v.target.policyName === null)
export const credentialStatusSchema = z
	.object({
		provider: credentialProviderSchema,
		configured: z.boolean(),
		revision: nhDetailsSchema.shape.revision,
		apiVersion: z.enum(['2023-09-01', '2023-10-01-preview']),
	})
	.strict()
const secret = z
	.string()
	.min(1)
	.max(8192)
	.refine(
		(v) => !!v.trim() && !/[\x00-\x1f\x7f]/.test(v),
		'Use a non-empty credential without control characters.',
	)
const artifact = z.string().uuid()
const environment = z.enum(['production', 'sandbox'])
const replacementSchema = z.discriminatedUnion('provider', [
	z
		.object({
			provider: z.literal('apns-token'),
			artifactId: artifact,
			environment,
			keyId: z.string().regex(/^[A-Z0-9]{10}$/),
			teamId: z.string().regex(/^[A-Z0-9]{10}$/),
			bundleId: z
				.string()
				.min(1)
				.max(255)
				.regex(/^[A-Za-z0-9.-]+$/),
		})
		.strict(),
	z
		.object({ provider: z.literal('apns-certificate'), artifactId: artifact, environment })
		.strict(),
	z.object({ provider: z.literal('mpns-certificate'), artifactId: artifact }).strict(),
	z.object({ provider: z.literal('fcm-v1'), artifactId: artifact }).strict(),
	z.object({ provider: z.literal('wns'), packageSid: secret, secretKey: secret }).strict(),
	z.object({ provider: z.literal('adm'), clientId: secret, clientSecret: secret }).strict(),
	z.object({ provider: z.literal('baidu'), apiKey: secret, secretKey: secret }).strict(),
	z
		.object({
			provider: z.literal('browser'),
			subject: z
				.string()
				.min(1)
				.max(2048)
				.refine((v) => {
					if (/[\x00-\x20\x7f]/.test(v)) return false
					try {
						const u = new URL(v)
						return (
							(u.protocol === 'https:' &&
								!!u.hostname &&
								!u.username &&
								!u.password &&
								!u.hash) ||
							(u.protocol === 'mailto:' &&
								/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.pathname) &&
								!u.search &&
								!u.hash)
						)
					} catch {
						return false
					}
				}, 'Use a mailto: contact address or HTTPS contact URL.'),
			vapidPublicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
			vapidPrivateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		})
		.strict(),
	z
		.object({
			provider: z.literal('xiaomi'),
			appSecret: secret,
			endpoint: z
				.string()
				.url()
				.max(2048)
				.refine((v) => {
					try {
						const u = new URL(v)
						return (
							u.protocol === 'https:' &&
							!u.username &&
							!u.password &&
							!u.hash &&
							!u.search &&
							(u.port === '' || u.port === '443') &&
							/^(?:api|api-[a-z]{2})\.xmpush\.xiaomi\.com$/.test(u.hostname) &&
							u.pathname === '/v3/message/regid'
						)
					} catch {
						return false
					}
				}, 'Use an HTTPS Xiaomi regional endpoint ending in /v3/message/regid.'),
		})
		.strict(),
])
export const credentialDraftSchema = z.union([
	replacementSchema,
	z.object({ provider: credentialProviderSchema, remove: z.literal(true) }).strict(),
])
export const credentialChangeSchema = nhGetSchema
	.extend({
		expectedRevision: nhDetailsSchema.shape.revision,
		draft: credentialDraftSchema,
		acknowledged: z.literal(true),
	})
	.refine((v) => v.target.scope.kind === 'hub' && v.target.policyName === null)
export const credentialImportSchema = nhGetSchema
	.extend({
		provider: z.enum(['apns-token', 'apns-certificate', 'fcm-v1', 'mpns-certificate']),
		password: z.string().max(1024),
	})
	.refine(
		(v) =>
			v.target.scope.kind === 'hub' &&
			v.target.policyName === null &&
			(v.provider.endsWith('certificate') || v.password === ''),
	)
export const credentialArtifactSchema = z
	.object({
		artifactId: artifact,
		provider: credentialProviderSchema,
		summary: z.string().max(512),
		expiresAt: z.string().max(64),
	})
	.strict()
export const credentialImportResultSchema = z
	.object({ cancelled: z.boolean(), artifact: credentialArtifactSchema.nullable() })
	.strict()
export const credentialDiscardSchema = nhGetSchema.extend({ artifactId: artifact })
export type CredentialProvider = z.infer<typeof credentialProviderSchema>
export type CredentialGet = z.infer<typeof credentialGetSchema>
export type CredentialStatus = z.infer<typeof credentialStatusSchema>
export type CredentialDraft = z.infer<typeof credentialDraftSchema>
export type CredentialChange = z.infer<typeof credentialChangeSchema>
export type CredentialImport = z.infer<typeof credentialImportSchema>
export type CredentialArtifact = z.infer<typeof credentialArtifactSchema>
export type CredentialImportResult = z.infer<typeof credentialImportResultSchema>
export type CredentialDiscard = z.infer<typeof credentialDiscardSchema>
export const credentialLabels: Record<CredentialProvider, string> = {
	'apns-token': 'APNS token (.p8)',
	'apns-certificate': 'APNS certificate (.p12 / .pfx / .pem)',
	'fcm-v1': 'FCM v1 service account (.json)',
	wns: 'Windows (WNS)',
	adm: 'Amazon (ADM)',
	baidu: 'Baidu',
	'mpns-certificate': 'Legacy MPNS certificate (.p12 / .pfx / .pem)',
	browser: 'Browser (Web Push / VAPID)',
	xiaomi: 'Xiaomi (ARM configuration)',
	'gcm-legacy': 'Retired GCM / FCM credentials (removal only)',
}
