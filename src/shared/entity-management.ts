import { z } from 'zod'
import { entityTargetSchema } from './service-bus'

const duration = z.string().min(1).max(40)
const nullableBoolean = z.boolean().nullable()
// Nullable fields are not applicable to every entity kind; the host enforces that distinction.
export const entitySettingsSchema = z
	.object({
		status: z.string().min(1).max(32),
		defaultMessageTimeToLive: duration,
		autoDeleteOnIdle: duration,
		enableBatchedOperations: z.boolean(),
		userMetadata: z.string().max(1024),
		lockDuration: duration.nullable(),
		maxDeliveryCount: z.number().int().min(1).max(2147483647).nullable(),
		deadLetteringOnMessageExpiration: nullableBoolean,
		forwardTo: z.string().max(260).nullable(),
		forwardDeadLetteredMessagesTo: z.string().max(260).nullable(),
		requiresSession: nullableBoolean,
		maxSizeInMegabytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
		maxMessageSizeInKilobytes: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.nullable(),
		requiresDuplicateDetection: nullableBoolean,
		duplicateDetectionHistoryTimeWindow: duration.nullable(),
		enablePartitioning: nullableBoolean,
		supportOrdering: nullableBoolean,
		enableDeadLetteringOnFilterEvaluationExceptions: nullableBoolean,
	})
	.strict()
const base = z
	.object({ id: z.string().uuid(), connectionId: z.string().uuid(), target: entityTargetSchema })
	.strict()
const revision = z.string().regex(/^[A-F0-9]{64}$/)
export const entityConfigurationRequestSchema = base
export const createEntityRequestSchema = base.extend({ settings: entitySettingsSchema })
export const updateEntityRequestSchema = base.extend({
	settings: entitySettingsSchema,
	expectedRevision: revision,
})
export const deleteEntityRequestSchema = base.extend({
	expectedRevision: revision,
	confirmation: z.string().max(550),
})
export const entityConfigurationSchema = z
	.object({ target: entityTargetSchema, settings: entitySettingsSchema, revision })
	.strict()
export type EntitySettings = z.infer<typeof entitySettingsSchema>
export type EntityConfiguration = z.infer<typeof entityConfigurationSchema>
export type EntityConfigurationRequest = z.infer<typeof entityConfigurationRequestSchema>
export type CreateEntityRequest = z.infer<typeof createEntityRequestSchema>
export type UpdateEntityRequest = z.infer<typeof updateEntityRequestSchema>
export type DeleteEntityRequest = z.infer<typeof deleteEntityRequestSchema>
export function entityPath(target: EntityConfigurationRequest['target']): string {
	return target.kind === 'subscription'
		? `${target.topicName}/Subscriptions/${target.name}`
		: target.name
}
export function defaultEntitySettings(
	kind: EntityConfigurationRequest['target']['kind'],
): EntitySettings {
	const receiver = kind !== 'topic',
		sender = kind !== 'subscription'
	return {
		status: 'Active',
		defaultMessageTimeToLive: 'unlimited',
		autoDeleteOnIdle: 'disabled',
		enableBatchedOperations: true,
		userMetadata: '',
		lockDuration: receiver ? '00:01:00' : null,
		maxDeliveryCount: receiver ? 10 : null,
		deadLetteringOnMessageExpiration: receiver ? false : null,
		forwardTo: receiver ? '' : null,
		forwardDeadLetteredMessagesTo: receiver ? '' : null,
		requiresSession: receiver ? false : null,
		maxSizeInMegabytes: sender ? 1024 : null,
		maxMessageSizeInKilobytes: null,
		requiresDuplicateDetection: sender ? false : null,
		duplicateDetectionHistoryTimeWindow: sender ? '00:10:00' : null,
		enablePartitioning: sender ? false : null,
		supportOrdering: kind === 'topic' ? false : null,
		enableDeadLetteringOnFilterEvaluationExceptions: kind === 'subscription' ? true : null,
	}
}
