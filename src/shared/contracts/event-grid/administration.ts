import { z } from 'zod'
import { eventGridDeliverySchema, eventGridDeliveryDetailsSchema } from './delivery'
import { eventGridGetSchema, eventGridTargetSchema, eventGridRequestSchema } from './core'
export const eventGridOperators = [
	'BoolEquals',
	'IsNotNull',
	'IsNullOrUndefined',
	'NumberGreaterThan',
	'NumberGreaterThanOrEquals',
	'NumberIn',
	'NumberInRange',
	'NumberLessThan',
	'NumberLessThanOrEquals',
	'NumberNotIn',
	'NumberNotInRange',
	'StringBeginsWith',
	'StringContains',
	'StringEndsWith',
	'StringIn',
	'StringNotBeginsWith',
	'StringNotContains',
	'StringNotEndsWith',
	'StringNotIn',
] as const
export const eventGridAdminFilterSchema = z
	.object({
		key: z.string().min(1).max(512),
		operatorType: z.enum(eventGridOperators),
		// JSON text avoids rounding numbers before they reach Azure.
		operandJson: z.string().max(32768),
	})
	.strict()
export const eventGridSubscriptionSettingsSchema = z
	.object({
		deliveryMode: z.enum(['Queue', 'Push']),
		receiveLockDurationInSeconds: z.number().int().min(60).max(300).nullable(),
		maxDeliveryCount: z.number().int().min(1).max(10).nullable(),
		eventTimeToLive: z.string().min(1).max(64).nullable(),
		expirationTimeUtc: z.string().max(64).nullable(),
		includedEventTypes: z.array(z.string().min(1).max(1024)).max(100).nullable(),
		filters: z.array(eventGridAdminFilterSchema).max(25).nullable(),
	})
	.strict()
export const eventGridDestinationSchema = z.discriminatedUnion('endpointType', [
	z
		.object({
			endpointType: z.literal('WebHook'),
			endpointUrl: z
				.string()
				.max(8192)
				.url()
				.refine((v) => {
					const u = new URL(v)
					return (
						!/\s/.test(v) &&
						u.protocol === 'https:' &&
						!u.username &&
						!u.password &&
						!u.hash
					)
				}),
			resourceId: z.null(),
			queueName: z.null(),
		})
		.strict(),
	z
		.object({
			endpointType: z.enum([
				'EventHub',
				'ServiceBusQueue',
				'ServiceBusTopic',
				'NamespaceTopic',
				'AzureFunction',
				'HybridConnection',
				'StorageQueue',
			]),
			endpointUrl: z.null(),
			resourceId: z
				.string()
				.min(1)
				.max(1024)
				.regex(
					/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/[A-Za-z.]+\/.+/i,
				),
			queueName: z.string().max(63).nullable(),
		})
		.strict(),
])
export const eventGridAdminReadSchema = eventGridGetSchema.refine(
	(v) => v.target.kind !== 'namespace',
)
export const eventGridAdminDetailsSchema = z
	.object({
		target: eventGridTargetSchema,
		revision: z.string().regex(/^[A-F0-9]{64}$/),
		retentionDays: z.number().int().nullable(),
		settings: eventGridSubscriptionSettingsSchema.nullable(),
		warning: z.string().max(2048).nullable(),
		delivery: eventGridDeliveryDetailsSchema.nullable().optional(),
	})
	.strict()
export const eventGridAdminChangeSchema = eventGridGetSchema
	.extend({
		action: z.enum(['create', 'update', 'delete']),
		expectedRevision: z
			.string()
			.regex(/^[A-F0-9]{64}$/)
			.nullable(),
		retentionDays: z.number().int().min(1).max(7).nullable(),
		settings: eventGridSubscriptionSettingsSchema.nullable(),
		destination: eventGridDestinationSchema.nullable(),
		delivery: eventGridDeliverySchema.nullable().optional(),
		acknowledged: z.literal(true),
		confirmation: z.string().max(50).nullable(),
	})
	.superRefine((v, ctx) => {
		const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
		if (v.target.kind === 'namespace') fail('Choose a topic or subscription.')
		if ((v.action === 'create') !== (v.expectedRevision === null))
			fail('Read current settings before changing an existing resource.')
		if (v.action === 'delete') {
			if (
				v.confirmation !== (v.target.subscriptionName ?? v.target.topicName) ||
				v.settings !== null ||
				v.retentionDays !== null ||
				v.destination !== null ||
				v.delivery != null
			)
				fail('Confirm the exact resource name to delete.')
		} else if (v.confirmation !== null) fail('Unexpected deletion confirmation.')
		if (
			v.action !== 'delete' &&
			v.target.kind === 'topic' &&
			(v.retentionDays === null ||
				v.settings !== null ||
				v.destination !== null ||
				v.delivery != null)
		)
			fail('Specify topic retention only.')
		if (
			v.action !== 'delete' &&
			v.target.kind === 'subscription' &&
			(v.settings === null || v.retentionDays !== null)
		)
			fail('Specify subscription settings only.')
		if (
			v.destination !== null &&
			!(v.action !== 'delete' && v.settings?.deliveryMode === 'Push')
		)
			fail('Destinations apply only to Push subscriptions.')
		if (
			v.destination !== null &&
			v.action === 'update' &&
			(!v.delivery?.identity || v.delivery.headers === null)
		)
			fail(
				'Replacing a destination requires an explicit identity and fresh headers; existing credentials cannot be transferred.',
			)
		if (
			v.delivery &&
			v.settings?.deliveryMode !== 'Push' &&
			(v.delivery.identity !== null || v.delivery.headers !== null)
		)
			fail('Delivery identities and headers apply only to Push subscriptions.')
		if (
			v.delivery?.webhookAuthentication &&
			(v.settings?.deliveryMode !== 'Push' ||
				!['SystemAssigned', 'UserAssigned'].includes(v.delivery.identity?.type ?? '') ||
				(v.destination && v.destination.endpointType !== 'WebHook'))
		)
			fail(
				'Webhook token settings require an explicit managed identity and WebHook destination.',
			)
		if (
			v.action === 'create' &&
			v.target.kind === 'subscription' &&
			(v.settings?.filters === null ||
				(v.settings?.deliveryMode === 'Push' && v.destination === null))
		)
			fail('Specify filters and a Push destination when applicable.')
		if (v.settings?.deliveryMode === 'Push' && v.settings.receiveLockDurationInSeconds !== null)
			fail('Receive locks apply only to Queue subscriptions.')
		if (v.destination?.endpointType === 'StorageQueue' && !v.destination.queueName)
			fail('Specify the storage queue name.')
	})
export const eventGridAdminOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		target: eventGridTargetSchema,
		action: z.enum(['create', 'update', 'delete']),
		status: z.enum(['confirmed', 'accepted', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
	})
	.strict()
export const eventGridAdminResultSchema = eventGridRequestSchema.extend({
	operationId: z.string().uuid(),
})
export type EventGridAdminDetails = z.infer<typeof eventGridAdminDetailsSchema>
export type EventGridAdminChange = z.infer<typeof eventGridAdminChangeSchema>
export type EventGridAdminResult = z.infer<typeof eventGridAdminResultSchema>
export type EventGridAdminOutcome = z.infer<typeof eventGridAdminOutcomeSchema>
export type EventGridAdminFilter = z.infer<typeof eventGridAdminFilterSchema>
export type EventGridSubscriptionSettings = z.infer<typeof eventGridSubscriptionSettingsSchema>
export type EventGridDestination = z.infer<typeof eventGridDestinationSchema>
