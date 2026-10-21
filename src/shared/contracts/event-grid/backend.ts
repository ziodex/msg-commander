import { type ProfileInput } from '../platform/profiles'
import {
	type EventGridManagement,
	type EventGridRequest,
	type EventGridList,
	type EventGridGet,
	eventGridConnectionSchema,
	eventGridPageSchema,
	eventGridDetailsSchema,
} from './core'
import {
	type EventGridReceive,
	type EventGridSettle,
	type EventGridPullTarget,
	type EventGridPullInspect,
	type EventGridPullResultRequest,
	eventGridPullOutcomeSchema,
	eventGridReceivedListSchema,
	eventGridEventInspectionSchema,
} from './pulling'
import {
	type EventGridPublish,
	type EventGridPublishResultRequest,
	eventGridPublishOutcomeSchema,
} from './publishing'
import {
	type EventGridAdminChange,
	type EventGridAdminResult,
	eventGridAdminDetailsSchema,
	eventGridAdminOutcomeSchema,
} from './administration'
import { z } from 'zod'

export type EventGridBackendParams = {
	'eg.connect': { operationId: string; profile: ProfileInput; management: EventGridManagement }
	'eg.reset': Record<string, never>
	'eg.pull.receive': EventGridReceive
	'eg.pull.settle': EventGridSettle
	'eg.pull.list': EventGridPullTarget
	'eg.pull.clear': EventGridPullTarget
	'eg.pull.inspect': EventGridPullInspect
	'eg.pull.result': EventGridPullResultRequest
	'eg.publish': EventGridPublish
	'eg.publish.result': EventGridPublishResultRequest
	'eg.disconnect': EventGridRequest
	'eg.list': EventGridList
	'eg.admin.get': EventGridGet
	'eg.admin.change': EventGridAdminChange
	'eg.admin.result': EventGridAdminResult
	'eg.get': EventGridGet
}

export const eventGridBackendResults = {
	'eg.pull.receive': eventGridPullOutcomeSchema,
	'eg.pull.settle': eventGridPullOutcomeSchema,
	'eg.pull.list': eventGridReceivedListSchema,
	'eg.pull.clear': eventGridReceivedListSchema,
	'eg.pull.inspect': eventGridEventInspectionSchema,
	'eg.pull.result': eventGridPullOutcomeSchema.nullable(),
	'eg.publish': eventGridPublishOutcomeSchema,
	'eg.publish.result': eventGridPublishOutcomeSchema.nullable(),
	'eg.connect': eventGridConnectionSchema,
	'eg.reset': z.null(),
	'eg.disconnect': z.null(),
	'eg.list': eventGridPageSchema,
	'eg.get': eventGridDetailsSchema,
	'eg.admin.get': eventGridAdminDetailsSchema,
	'eg.admin.change': eventGridAdminOutcomeSchema,
	'eg.admin.result': eventGridAdminOutcomeSchema.nullable(),
}
