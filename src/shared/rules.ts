import { z } from 'zod'
import { entityTargetSchema } from './service-bus'

export const subscriptionTargetSchema = entityTargetSchema.options[2]
export type SubscriptionTarget = z.infer<typeof subscriptionTargetSchema>
export const rulePropertyTypes = [
	'string',
	'boolean',
	'int32',
	'int64',
	'double',
	'datetime',
	'timespan',
] as const
export const rulePropertySchema = z
	.object({
		name: z.string().min(1).max(128),
		type: z.string().min(1).max(64),
		value: z.string().max(4096),
	})
	.strict()
const properties = z.array(rulePropertySchema).max(32)
const header = z.string().max(260).nullable()
export const correlationSchema = z
	.object({
		correlationId: header,
		messageId: header,
		subject: header,
		contentType: header,
		to: header,
		replyTo: header,
		sessionId: header,
		replyToSessionId: header,
		properties,
	})
	.strict()
export const ruleDefinitionSchema = z
	.object({
		filterType: z.enum(['sql', 'correlation', 'true', 'false', 'unsupported']),
		sqlExpression: z.string().max(1024),
		filterParameters: properties,
		correlation: correlationSchema.nullable(),
		actionExpression: z.string().max(1024),
		actionParameters: properties,
	})
	.strict()
export const ruleSummarySchema = z
	.object({
		name: z.string().min(1).max(50),
		filterType: ruleDefinitionSchema.shape.filterType,
		hasAction: z.boolean(),
	})
	.strict()
export const ruleConfigurationSchema = z
	.object({
		name: z.string().min(1).max(50),
		definition: ruleDefinitionSchema,
		revision: z.string().regex(/^[A-F0-9]{64}$/),
		readOnlyReason: z.string().max(1024).nullable(),
	})
	.strict()
export const rulePageSchema = z
	.object({
		items: z.array(ruleSummarySchema).max(100),
		continuationToken: z.string().max(8192).nullable(),
	})
	.strict()
const base = z
	.object({
		id: z.string().uuid(),
		connectionId: z.string().uuid(),
		target: subscriptionTargetSchema,
	})
	.strict()
export const listRulesRequestSchema = base.extend({
	continuationToken: z.string().max(8192).nullable().optional(),
})
export const ruleRequestSchema = base.extend({ name: z.string().min(1).max(50) })
export const createRuleRequestSchema = ruleRequestSchema.extend({
	definition: ruleDefinitionSchema,
})
export const updateRuleRequestSchema = createRuleRequestSchema.extend({
	expectedRevision: ruleConfigurationSchema.shape.revision,
})
export const deleteRuleRequestSchema = ruleRequestSchema.extend({
	expectedRevision: ruleConfigurationSchema.shape.revision,
	confirmation: z.string().max(550),
})
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>
export type RuleProperty = z.infer<typeof rulePropertySchema>
export type RuleConfiguration = z.infer<typeof ruleConfigurationSchema>
export type RulePage = z.infer<typeof rulePageSchema>
export type ListRulesRequest = z.infer<typeof listRulesRequestSchema>
export type RuleRequest = z.infer<typeof ruleRequestSchema>
export type CreateRuleRequest = z.infer<typeof createRuleRequestSchema>
export type UpdateRuleRequest = z.infer<typeof updateRuleRequestSchema>
export type DeleteRuleRequest = z.infer<typeof deleteRuleRequestSchema>
export function rulePath(target: SubscriptionTarget, name: string) {
	return `${target.topicName}/Subscriptions/${target.name}/Rules/${name}`
}
export function emptyCorrelation(): NonNullable<RuleDefinition['correlation']> {
	return {
		correlationId: null,
		messageId: null,
		subject: null,
		contentType: null,
		to: null,
		replyTo: null,
		sessionId: null,
		replyToSessionId: null,
		properties: [],
	}
}
export function defaultRule(): RuleDefinition {
	return {
		filterType: 'sql',
		sqlExpression: "user.color = 'blue'",
		filterParameters: [],
		correlation: null,
		actionExpression: '',
		actionParameters: [],
	}
}
