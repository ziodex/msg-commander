import { defineStore } from 'pinia'
import { useWorkspace } from '@/shared/workspace/store'
import { createEventHubsState } from '../model/state'
import type { EventHubsActions } from '../model/actions'
import { createEventHubsTasks } from '../composables/tasks'
import { createEventHubsTabs } from '../composables/tabs'
import { createEventHubsLifecycle } from '../composables/lifecycle'
import { createEventHubsBrowsing } from '../composables/browsing'
import { createEventHubsReading } from '../composables/reading'
import { createEventHubsInspection } from '../composables/inspection'
import { createEventHubsSending } from '../composables/sending'
import { createEventHubsTools } from '../composables/tools'

export const useEventHubs = defineStore('event-hubs', () => {
	const workspace = useWorkspace()
	const state = createEventHubsState(workspace)
	const {
		connection,
		hubs,
		groups,
		hubName,
		hub,
		partition,
		partitionId,
		consumerGroup,
		busy,
		error,
		operationId,
		readId,
		result,
		interrupted,
		event,
		body,
		bodyOffset,
		nextOffset,
		sendId,
		sendResult,
		sendInterrupted,
		sendJob,
		sending,
		statistics,
		urlNotice,
		readJob,
		reading,
		tabs,
		activeTabId,
		serviceName,
	} = state
	const actions: EventHubsActions = {
		clearSend: (...args) => sendingWorkflow.clearSend(...args),
		rememberTab: (...args) => tabsWorkflow.rememberTab(...args),
		persistTabs: (...args) => tabsWorkflow.persistTabs(...args),
		activateTab: (...args) => tabsWorkflow.activateTab(...args),
		closeTab: (...args) => tabsWorkflow.closeTab(...args),
		openTab: (...args) => tabsWorkflow.openTab(...args),
		reset: (...args) => lifecycleWorkflow.reset(...args),
		clearEvent: (...args) => inspectionWorkflow.clearEvent(...args),
		task: (...args) => tasksWorkflow.task(...args),
		connect: (...args) => lifecycleWorkflow.connect(...args),
		disconnect: (...args) => lifecycleWorkflow.disconnect(...args),
		listHubs: (...args) => browsingWorkflow.listHubs(...args),
		listGroups: (...args) => browsingWorkflow.listGroups(...args),
		selectHub: (...args) => browsingWorkflow.selectHub(...args),
		selectPartition: (...args) => browsingWorkflow.selectPartition(...args),
		read: (...args) => readingWorkflow.read(...args),
		recoverRead: (...args) => readingWorkflow.recoverRead(...args),
		inspect: (...args) => inspectionWorkflow.inspect(...args),
		readBody: (...args) => inspectionWorkflow.readBody(...args),
		send: (...args) => sendingWorkflow.send(...args),
		recoverSend: (...args) => sendingWorkflow.recoverSend(...args),
		refreshStatistics: (...args) => toolsWorkflow.refreshStatistics(...args),
		copyUrl: (...args) => toolsWorkflow.copyUrl(...args),
		cancel: (...args) => lifecycleWorkflow.cancel(...args),
	}
	const tasksWorkflow = createEventHubsTasks(state, workspace)
	const tabsWorkflow = createEventHubsTabs(state, actions)
	const lifecycleWorkflow = createEventHubsLifecycle(state, actions, workspace)
	const browsingWorkflow = createEventHubsBrowsing(state, actions)
	const readingWorkflow = createEventHubsReading(state, actions)
	const inspectionWorkflow = createEventHubsInspection(state, actions)
	const sendingWorkflow = createEventHubsSending(state, actions)
	const toolsWorkflow = createEventHubsTools(state, actions)
	const {
		clearSend,
		activateTab,
		closeTab,
		reset,
		clearEvent,
		task,
		connect,
		disconnect,
		listHubs,
		listGroups,
		selectHub,
		selectPartition,
		read,
		recoverRead,
		inspect,
		readBody,
		send,
		recoverSend,
		refreshStatistics,
		copyUrl,
		cancel,
	} = actions
	const connectIot = (profileId: string) =>
		connect({ profileId, hubName: '', management: null }, true)
	return {
		tabs,
		activeTabId,
		activateTab,
		closeTab,
		statistics,
		urlNotice,
		refreshStatistics,
		copyUrl,
		serviceName,
		connectIot,
		task,
		clearEvent,
		sendId,
		sendResult,
		sendInterrupted,
		sendJob,
		sending,
		send,
		recoverSend,
		clearSend,
		connection,
		hubs,
		groups,
		hubName,
		hub,
		partition,
		partitionId,
		consumerGroup,
		busy,
		error,
		operationId,
		readId,
		readJob,
		reading,
		result,
		interrupted,
		event,
		body,
		bodyOffset,
		nextOffset,
		reset,
		connect,
		disconnect,
		listHubs,
		listGroups,
		selectHub,
		selectPartition,
		read,
		recoverRead,
		inspect,
		readBody,
		cancel,
	}
})
