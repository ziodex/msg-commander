import { defineStore } from 'pinia'
import { useWorkspace } from '@/shared/workspace/store'
import { createEventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'
import { createEventGridTasks } from '../composables/tasks'
import { createEventGridLifecycle } from '../composables/lifecycle'
import { createEventGridBrowsing } from '../composables/browsing'
import { createEventGridInspection } from '../composables/inspection'
import { createEventGridAdministration } from '../composables/administration'
import { createEventGridPublishing } from '../composables/publishing'
import { createEventGridPulling } from '../composables/pulling'

export const useEventGrid = defineStore('event-grid', () => {
	const workspace = useWorkspace()
	const state = createEventGridState()
	const {
		connection,
		topics,
		subscriptions,
		expanded,
		details,
		inspection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		publishOutcome,
		publishReviewed,
		received,
		eventInspection,
		pullOutcome,
		pullReviewed,
		blocked,
		writeBlocked,
	} = state
	const actions: EventGridActions = {
		reset: (...args) => lifecycleWorkflow.reset(...args),
		task: (...args) => tasksWorkflow.task(...args),
		connect: (...args) => lifecycleWorkflow.connect(...args),
		disconnect: (...args) => lifecycleWorkflow.disconnect(...args),
		loadTopics: (...args) => browsingWorkflow.loadTopics(...args),
		loadSubscriptions: (...args) => browsingWorkflow.loadSubscriptions(...args),
		toggle: (...args) => browsingWorkflow.toggle(...args),
		inspect: (...args) => inspectionWorkflow.inspect(...args),
		refreshInspection: (...args) => inspectionWorkflow.refreshInspection(...args),
		closeInspection: (...args) => inspectionWorkflow.closeInspection(...args),
		adminGet: (...args) => administrationWorkflow.adminGet(...args),
		change: (...args) => administrationWorkflow.change(...args),
		recover: (...args) => administrationWorkflow.recover(...args),
		afterChange: (...args) => administrationWorkflow.afterChange(...args),
		publish: (...args) => publishingWorkflow.publish(...args),
		recoverPublish: (...args) => publishingWorkflow.recoverPublish(...args),
		refreshReceived: (...args) => pullingWorkflow.refreshReceived(...args),
		inspectEvent: (...args) => pullingWorkflow.inspectEvent(...args),
		pull: (...args) => pullingWorkflow.pull(...args),
		recoverPull: (...args) => pullingWorkflow.recoverPull(...args),
		cancel: (...args) => lifecycleWorkflow.cancel(...args),
		receive: (...args) => pullingWorkflow.receive(...args),
		settle: (...args) => pullingWorkflow.settle(...args),
	}
	const tasksWorkflow = createEventGridTasks(state, workspace)
	const lifecycleWorkflow = createEventGridLifecycle(state, actions, workspace)
	const browsingWorkflow = createEventGridBrowsing(state, actions)
	const inspectionWorkflow = createEventGridInspection(state, actions)
	const administrationWorkflow = createEventGridAdministration(state, actions)
	const publishingWorkflow = createEventGridPublishing(state, actions)
	const pullingWorkflow = createEventGridPulling(state, actions)
	const {
		reset,
		task,
		connect,
		disconnect,
		loadTopics,
		loadSubscriptions,
		toggle,
		inspect,
		refreshInspection,
		closeInspection,
		adminGet,
		change,
		recover,
		afterChange,
		publish,
		recoverPublish,
		refreshReceived,
		inspectEvent,
		recoverPull,
		cancel,
		receive,
		settle,
	} = actions
	return {
		received,
		eventInspection,
		pullOutcome,
		pullReviewed,
		refreshReceived,
		inspectEvent,
		receive,
		settle,
		recoverPull,
		publish,
		publishOutcome,
		publishReviewed,
		recoverPublish,
		outcome,
		reviewed,
		writeBlocked,
		adminGet,
		change,
		recover,
		afterChange,
		connection,
		topics,
		subscriptions,
		expanded,
		details,
		inspection,
		busy,
		operationId,
		error,
		blocked,
		reset,
		task,
		connect,
		disconnect,
		loadTopics,
		loadSubscriptions,
		toggle,
		inspect,
		refreshInspection,
		closeInspection,
		cancel,
	}
})
