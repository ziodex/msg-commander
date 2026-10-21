import { EventGridController } from '../features/event-grid/controller'
import { BodyCodecFiles } from '../features/body-tools/files'

import { NotificationHubRegistrationFiles } from '../features/notification-hubs/registrations/files'

import { NotificationHubFiles } from '../features/notification-hubs/configuration/files'

import { NotificationHubCredentialFiles } from '../features/notification-hubs/credentials/files'
import { NotificationSenderController } from '../features/notification-hubs/notifications/controller'

import { NotificationHubRegistrationsController } from '../features/notification-hubs/registrations/controller'

import { NotificationHubsController } from '../features/notification-hubs/controller'

import { RelayFiles } from '../features/relay/files'

import { HybridController } from '../features/relay/hybrid-controller'

import { RelayController } from '../features/relay/controller'

import { EventFiles } from '../features/event-hubs/files'
import { MessagingConfigurationFiles } from '../features/resource-configuration/files'
import { type MessagingService } from '../../shared/contracts/resource-configuration'

import { EventHubsController } from '../features/event-hubs/controller'

import { BrowserWindow } from 'electron'

import { Backend } from '../platform/backend'
import { MessageFiles } from '../features/service-bus/files/message-files'

import { WorkspaceStore } from '../platform/workspace-store'
import { ServiceBusController } from '../features/service-bus/controller'

export interface MainIpcContext {
	checkForUpdates(): Promise<void>
	backend: Backend
	bodyCodecs: BodyCodecFiles
	credentialFiles: NotificationHubCredentialFiles
	eventFiles: EventFiles
	eventHubs: EventHubsController
	grid: EventGridController
	hybrid: HybridController
	messageFiles: MessageFiles | undefined
	messagingFiles: MessagingConfigurationFiles
	nh: NotificationHubsController
	nhFiles: NotificationHubFiles
	notifications: NotificationSenderController
	operations: Map<string, AbortController>
	registrationFiles: NotificationHubRegistrationFiles
	registrations: NotificationHubRegistrationsController
	relay: RelayController
	relayFiles: RelayFiles
	requireMessaging: (service: MessagingService, connectionId: string) => void
	resetNamespaces: () => Promise<void>
	restarting: boolean
	serviceBus: ServiceBusController
	window: BrowserWindow | undefined
	workspace: WorkspaceStore
}
