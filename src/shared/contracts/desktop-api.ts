import { type BodyToolsDesktopApi } from './body-tools/desktop-api'
import { type EventGridDesktopApi } from './event-grid/desktop-api'
import { type EventHubsDesktopApi } from './event-hubs/desktop-api'
import { type NotificationHubsDesktopApi } from './notification-hubs/desktop-api'
import { type RelayDesktopApi } from './relay/desktop-api'
import { type ResourceConfigurationDesktopApi } from './resource-configuration/desktop-api'
import { type ServiceBusDesktopApi } from './service-bus/desktop-api'
import { type WorkspaceDesktopApi } from './workspace/desktop-api'

// Explicit feature interfaces preserve the narrow public desktop surface.
export interface CommanderApi
	extends
		BodyToolsDesktopApi,
		EventGridDesktopApi,
		EventHubsDesktopApi,
		NotificationHubsDesktopApi,
		RelayDesktopApi,
		ResourceConfigurationDesktopApi,
		ServiceBusDesktopApi,
		WorkspaceDesktopApi {}
