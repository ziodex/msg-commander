import { type EventGridBackendParams, eventGridBackendResults } from './event-grid/backend'
import {
	type NotificationHubsBackendParams,
	notificationHubsBackendResults,
} from './notification-hubs/backend'
import { type RelayBackendParams, relayBackendResults } from './relay/backend'
import { type EventHubsBackendParams, eventHubsBackendResults } from './event-hubs/backend'
import {
	type ResourceConfigurationBackendParams,
	resourceConfigurationBackendResults,
} from './resource-configuration/backend'
import { type ServiceBusBackendParams, serviceBusBackendResults } from './service-bus/backend'
import { type BodyToolsBackendParams, bodyToolsBackendResults } from './body-tools/backend'
import { type PlatformBackendParams, platformBackendResults } from './platform/backend'
import { z } from 'zod'

type BackendParams = EventGridBackendParams &
	NotificationHubsBackendParams &
	RelayBackendParams &
	EventHubsBackendParams &
	ResourceConfigurationBackendParams &
	ServiceBusBackendParams &
	BodyToolsBackendParams &
	PlatformBackendParams

export const backendResults = {
	...eventGridBackendResults,
	...notificationHubsBackendResults,
	...relayBackendResults,
	...eventHubsBackendResults,
	...resourceConfigurationBackendResults,
	...serviceBusBackendResults,
	...bodyToolsBackendResults,
	...platformBackendResults,
}

// The runtime result validators are the single source of result types.
export type BackendMethods = {
	[M in keyof BackendParams]: {
		params: BackendParams[M]
		result: z.output<(typeof backendResults)[M]>
	}
}
