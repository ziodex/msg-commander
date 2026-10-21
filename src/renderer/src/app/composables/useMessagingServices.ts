import { receiveServiceBusProgress } from '@/features/service-bus'
import { receiveEventHubsProgress } from '@/features/event-hubs'
import { receiveEventGridProgress } from '@/features/event-grid'
import { computed } from 'vue'
import { useHybrid } from '@/features/relay'
import { useNotificationSender } from '@/features/notification-hubs'
import { useNotificationHubRegistrations } from '@/features/notification-hubs'
import { useNotificationHubs } from '@/features/notification-hubs'
import { useEventGrid } from '@/features/event-grid'
import { useRelay } from '@/features/relay'
import { useEventHubs } from '@/features/event-hubs'
import { useServiceBus } from '@/features/service-bus'
import { useListeners } from '@/features/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import type { AppEvent } from '@shared/contracts'

// Composes messaging features and routes desktop events at the application boundary.
export function useMessagingServices() {
	const workspace = useWorkspace(),
		sb = useServiceBus(),
		eh = useEventHubs(),
		nh = useNotificationHubs(),
		relay = useRelay(),
		grid = useEventGrid()
	const registrations = useNotificationHubRegistrations(),
		notifications = useNotificationSender(),
		hybrid = useHybrid()
	useListeners()
	const connectedProfileIds = computed(() =>
		[sb, eh, relay, nh, grid, registrations, notifications].flatMap((feature) =>
			feature.connection ? [feature.connection.profileId] : [],
		),
	)
	function receive(event: AppEvent) {
		if (event.type === 'namespace-reset') sb.reset()
		else if (event.type === 'event-hubs-reset') eh.reset()
		else if (event.type === 'notification-hubs-reset') nh.reset()
		else if (event.type === 'notification-sender-reset') notifications.reset()
		else if (event.type === 'notification-hub-registrations-reset') registrations.reset()
		else if (event.type === 'event-grid-reset') grid.reset()
		else if (event.type === 'relay-reset') relay.reset()
		else if (event.type === 'hybrid-reset') hybrid.reset()
		else if (event.type === 'hybrid-progress') hybrid.receive(event)
		else {
			if (receiveServiceBusProgress(workspace.jobs, event)) return
			if (receiveEventHubsProgress(workspace.jobs, event)) return
			if (receiveEventGridProgress(workspace.jobs, event)) return
			workspace.receive(event)
		}
	}
	return {
		sb,
		eh,
		nh,
		relay,
		grid,
		registrations,
		notifications,
		hybrid,
		connectedProfileIds,
		receive,
	}
}
