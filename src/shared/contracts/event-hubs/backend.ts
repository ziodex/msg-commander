import {
	type EventListen,
	type EventListenResultRequest,
	eventListenResultSchema,
} from './listening'
import { type InspectRequest, type BodyRequest, bodyChunkSchema } from '../../service-bus'
import {
	type EventHubsRequest,
	type EventHubsManagement,
	type EventHubsList,
	type EventHubRequest,
	type EventHubPartitionRequest,
	type EventHubRead,
	type EventHubReadResultRequest,
	eventHubsConnectionSchema,
	eventHubsPageSchema,
	eventHubSchema,
	eventHubPartitionSchema,
	eventHubStatisticsSchema,
	eventHubReadResultSchema,
	eventDetailsSchema,
} from './core'
import {
	type EventAdminGet,
	type EventPolicyList,
	type EventAdminChange,
	type EventAdminResult,
	type EventPolicyKeyRequest,
	eventAdminContextSchema,
	eventAdminDetailsSchema,
	eventPolicyPageSchema,
	eventAdminOutcomeSchema,
	eventPolicyKeySchema,
} from './administration'
import { type ProfileInput } from '../platform/profiles'
import {
	type EventHubSend,
	type EventHubSendResultRequest,
	eventHubSendResultSchema,
} from './sending'
import { eventExportMetadataSchema } from './files'
import { z } from 'zod'

export type EventHubsBackendParams = {
	'eh.listen': EventListen
	'eh.listen.result': EventListenResultRequest
	'eh.export': InspectRequest
	'eh.admin.context': EventHubsRequest
	'eh.admin.get': EventAdminGet
	'eh.admin.policies': EventPolicyList
	'eh.admin.change': EventAdminChange
	'eh.admin.result': EventAdminResult
	'eh.admin.key': EventPolicyKeyRequest
	'eh.connect': {
		operationId: string
		profile: ProfileInput
		hubName: string
		management: EventHubsManagement | null
		access?: 'read' | 'send'
	}
	'eh.reset': Record<string, never>
	'eh.disconnect': EventHubsRequest
	'eh.list': EventHubsList
	'eh.hub': EventHubRequest
	'eh.statistics': EventHubRequest
	'eh.partition': EventHubPartitionRequest
	'eh.send': EventHubSend
	'eh.send.result': EventHubSendResultRequest
	'eh.read': EventHubRead
	'eh.read.result': EventHubReadResultRequest
	'eh.inspect': InspectRequest
	'eh.body': BodyRequest
}

export const eventHubsBackendResults = {
	'eh.listen': eventListenResultSchema,
	'eh.listen.result': eventListenResultSchema.nullable(),
	'eh.export': eventExportMetadataSchema,
	'eh.connect': eventHubsConnectionSchema,
	'eh.reset': z.null(),
	'eh.disconnect': z.null(),
	'eh.list': eventHubsPageSchema,
	'eh.hub': eventHubSchema,
	'eh.partition': eventHubPartitionSchema,
	'eh.statistics': eventHubStatisticsSchema,
	'eh.send': eventHubSendResultSchema,
	'eh.send.result': eventHubSendResultSchema.nullable(),
	'eh.admin.context': eventAdminContextSchema,
	'eh.admin.get': eventAdminDetailsSchema,
	'eh.admin.policies': eventPolicyPageSchema,
	'eh.admin.change': eventAdminOutcomeSchema,
	'eh.admin.result': eventAdminOutcomeSchema.nullable(),
	'eh.admin.key': eventPolicyKeySchema,
	'eh.read': eventHubReadResultSchema,
	'eh.read.result': eventHubReadResultSchema.nullable(),
	'eh.inspect': eventDetailsSchema,
	'eh.body': bodyChunkSchema,
}
