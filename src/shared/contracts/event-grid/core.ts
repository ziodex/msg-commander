import { z } from 'zod'
import { propertySchema } from '../../service-bus'
const id = z.string().uuid()
export const eventGridNameSchema = z.string().regex(/^[A-Za-z0-9-]{3,50}$/)
export const eventGridHostSchema = z
	.string()
	.max(253)
	.regex(/^[a-z0-9-]{3,50}\.[a-z0-9-]+\.eventgrid\.azure\.net$/i)
export const eventGridManagementSchema = z
	.object({
		resourceId: z
			.string()
			.max(1024)
			.regex(
				/^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9_().-]{1,90}\/providers\/Microsoft\.EventGrid\/namespaces\/[A-Za-z0-9-]{3,50}$/i,
			)
			.refine((v) => !v.split('/').some((p) => p === '.' || p === '..')),
		tenantId: z.string().regex(/^[A-Za-z0-9.-]{1,100}$/),
		clientId: id,
	})
	.strict()
export const eventGridTargetSchema = z.discriminatedUnion('kind', [
	z
		.object({ kind: z.literal('namespace'), topicName: z.null(), subscriptionName: z.null() })
		.strict(),
	z
		.object({
			kind: z.literal('topic'),
			topicName: eventGridNameSchema,
			subscriptionName: z.null(),
		})
		.strict(),
	z
		.object({
			kind: z.literal('subscription'),
			topicName: eventGridNameSchema,
			subscriptionName: eventGridNameSchema,
		})
		.strict(),
])
export const eventGridConnectSchema = z
	.object({ id, profileId: id, management: eventGridManagementSchema })
	.strict()
export const eventGridRequestSchema = z.object({ id, connectionId: id }).strict()
export const eventGridGetSchema = eventGridRequestSchema.extend({ target: eventGridTargetSchema })
export const eventGridListSchema = eventGridGetSchema
	.extend({ continuationToken: id.nullable() })
	.refine((v) => v.target.kind !== 'subscription', 'Choose the namespace or parent topic.')
export const eventGridConnectionSchema = z
	.object({
		connectionId: id,
		profileId: id,
		namespace: eventGridHostSchema,
		resourceId: eventGridManagementSchema.shape.resourceId,
		location: z.string().max(128),
		connectedAt: z.string().max(64),
	})
	.strict()
export const eventGridItemSchema = z
	.object({
		target: eventGridTargetSchema,
		name: eventGridNameSchema,
		provisioningState: z.string().max(128).nullable(),
		deliveryMode: z.string().max(128).nullable(),
		inputSchema: z.string().max(128).nullable(),
	})
	.strict()
export const eventGridPageSchema = z
	.object({ items: z.array(eventGridItemSchema).max(250), continuationToken: id.nullable() })
	.strict()
export const eventGridDetailsSchema = z
	.object({
		target: eventGridTargetSchema,
		resourceId: z.string().max(1024),
		name: eventGridNameSchema,
		properties: z.array(propertySchema).max(40),
		filters: z
			.object({
				includedEventTypes: z.array(z.string().max(1024)).max(100).nullable(),
				filters: z
					.array(
						z
							.object({
								key: z.string().max(1024).nullable(),
								operatorType: z.string().max(128).nullable(),
								known: z.boolean(),
								definitionJson: z.string().max(65536),
							})
							.strict(),
					)
					.max(100),
			})
			.strict()
			.nullable(),
		deliveryJson: z.string().max(131072).nullable(),
		warning: z.string().max(2048).nullable(),
		capturedAt: z.string().max(64),
	})
	.strict()
export type EventGridManagement = z.infer<typeof eventGridManagementSchema>
export type EventGridTarget = z.infer<typeof eventGridTargetSchema>
export type EventGridConnect = z.infer<typeof eventGridConnectSchema>
export type EventGridRequest = z.infer<typeof eventGridRequestSchema>
export type EventGridGet = z.infer<typeof eventGridGetSchema>
export type EventGridList = z.infer<typeof eventGridListSchema>
export type EventGridConnection = z.infer<typeof eventGridConnectionSchema>
export type EventGridPage = z.infer<typeof eventGridPageSchema>
export type EventGridDetails = z.infer<typeof eventGridDetailsSchema>
export const eventGridNamespace: EventGridTarget = {
	kind: 'namespace',
	topicName: null,
	subscriptionName: null,
}
export const eventGridTopic = (topicName: string): EventGridTarget => ({
	kind: 'topic',
	topicName,
	subscriptionName: null,
})
export const eventGridPath = (target: EventGridTarget) =>
	target.kind === 'namespace'
		? 'namespace'
		: `topics/${target.topicName}${target.kind === 'subscription' ? '/subscriptions/' + target.subscriptionName : ''}`
