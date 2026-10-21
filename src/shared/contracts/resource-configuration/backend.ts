import {
	type MessagingConfigExport,
	type MessagingConfigRequest,
	type MessagingConfigApply,
	type MessagingConfigResultRequest,
	messagingConfigEncodedSchema,
	messagingConfigPreviewSchema,
	messagingConfigResultSchema,
} from '../resource-configuration'
import { z } from 'zod'

export type ResourceConfigurationBackendParams = {
	'sb.config.export': MessagingConfigExport
	'eh.config.export': MessagingConfigExport
	'sb.config.preview': MessagingConfigRequest & { contentBase64: string }
	'eh.config.preview': MessagingConfigRequest & { contentBase64: string }
	'sb.config.discard': MessagingConfigRequest
	'eh.config.discard': MessagingConfigRequest
	'sb.config.apply': MessagingConfigApply
	'eh.config.apply': MessagingConfigApply
	'sb.config.result': MessagingConfigResultRequest
	'eh.config.result': MessagingConfigResultRequest
}

export const resourceConfigurationBackendResults = {
	'sb.config.export': messagingConfigEncodedSchema,
	'eh.config.export': messagingConfigEncodedSchema,
	'sb.config.preview': messagingConfigPreviewSchema,
	'eh.config.preview': messagingConfigPreviewSchema,
	'sb.config.discard': z.null(),
	'eh.config.discard': z.null(),
	'sb.config.apply': messagingConfigResultSchema,
	'eh.config.apply': messagingConfigResultSchema,
	'sb.config.result': messagingConfigResultSchema.nullable(),
	'eh.config.result': messagingConfigResultSchema.nullable(),
}
