import { z } from 'zod'
import { type BulkEntityProgress, bulkEntityProgressSchema } from '../../bulk-entities'
import {
	type EventGridPublishProgress,
	eventGridPublishProgressSchema,
} from '../event-grid/publishing'
import { type EventGridPullProgress, eventGridPullProgressSchema } from '../event-grid/pulling'
import { type EventHubReadProgress, eventHubReadProgressSchema } from '../event-hubs/core'
import { type EventListenProgress, eventListenProgressSchema } from '../event-hubs/listening'
import { type EventHubSendProgress, eventHubSendProgressSchema } from '../event-hubs/sending'
import { type HybridProgress, hybridProgressSchema } from '../relay/hybrid'
import {
	type BulkPurgeProgress,
	bulkPurgeProgressSchema,
	type PurgeProgress,
	purgeProgressSchema,
	type ReceiveDeleteProgress,
	receiveDeleteProgressSchema,
	type ResendProgress,
	resendProgressSchema,
} from '../service-bus/maintenance/index'
import { type TestJobProgress, testJobProgressSchema } from '../service-bus/test-jobs'
import { idSchema } from './profiles'
import { type BackendStatus } from './protocol'

export type AppEvent =
	| EventGridPullProgress
	| EventGridPublishProgress
	| HybridProgress
	| { type: 'hybrid-reset' }
	| EventListenProgress
	| EventHubSendProgress
	| EventHubReadProgress
	| { type: 'event-hubs-reset' }
	| { type: 'relay-reset' }
	| { type: 'event-grid-reset' }
	| { type: 'notification-hubs-reset' }
	| { type: 'notification-hub-registrations-reset' }
	| { type: 'notification-sender-reset' }
	| TestJobProgress
	| ReceiveDeleteProgress
	| ResendProgress
	| BulkEntityProgress
	| BulkPurgeProgress
	| PurgeProgress
	| { type: 'namespace-reset' }
	| { type: 'backend'; status: BackendStatus }
	| { type: 'progress'; operationId: string; percent: number; message: string }
	| { type: 'device-code'; operationId: string; code: string; expiresOn: string }
	| { type: 'command'; command: 'new-connection' | 'palette' }

export const backendEventSchema = z.discriminatedUnion('type', [
	hybridProgressSchema,
	eventGridPublishProgressSchema,
	eventGridPullProgressSchema,
	eventListenProgressSchema,
	eventHubReadProgressSchema,
	eventHubSendProgressSchema,
	testJobProgressSchema,
	receiveDeleteProgressSchema,
	purgeProgressSchema,
	bulkPurgeProgressSchema,
	bulkEntityProgressSchema,
	resendProgressSchema,
	z
		.object({
			type: z.literal('progress'),
			operationId: idSchema,
			percent: z.number().min(0).max(100),
			message: z.string().max(1024),
		})
		.strict(),
	z
		.object({
			type: z.literal('device-code'),
			operationId: idSchema,
			code: z.string().max(32),
			expiresOn: z.string().max(64),
		})
		.strict(),
])
