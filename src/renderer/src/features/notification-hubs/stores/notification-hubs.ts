import { defineStore } from 'pinia'
import { useWorkspace } from '@/shared/workspace/store'
import { createNotificationManagementState } from '../model/management-state'
import type { NotificationManagementActions } from '../model/management-actions'
import { createNotificationManagementTasks } from '../composables/management/tasks'
import { createNotificationManagementLifecycle } from '../composables/management/lifecycle'
import { createNotificationManagementBrowsing } from '../composables/management/browsing'
import { createNotificationManagementMutations } from '../composables/management/mutations'
import { createNotificationManagementConfiguration } from '../composables/management/configuration'

export const useNotificationHubs = defineStore('notification-hubs', () => {
	const workspace = useWorkspace()
	const state = createNotificationManagementState()
	const {
		connection,
		busy,
		operationId,
		error,
		hubs,
		selected,
		details,
		policies,
		outcome,
		reviewed,
		configPreview,
		configFileName,
		configOutcome,
		configReviewed,
		blocked,
	} = state
	const actions: NotificationManagementActions = {
		reset: (...args) => lifecycleWorkflow.reset(...args),
		task: (...args) => tasksWorkflow.task(...args),
		run: (...args) => tasksWorkflow.run(...args),
		connect: (...args) => lifecycleWorkflow.connect(...args),
		disconnect: (...args) => lifecycleWorkflow.disconnect(...args),
		list: (...args) => browsingWorkflow.list(...args),
		listPolicies: (...args) => browsingWorkflow.listPolicies(...args),
		select: (...args) => browsingWorkflow.select(...args),
		refresh: (...args) => browsingWorkflow.refresh(...args),
		change: (...args) => mutationsWorkflow.change(...args),
		recover: (...args) => mutationsWorkflow.recover(...args),
		afterChange: (...args) => mutationsWorkflow.afterChange(...args),
		importConfiguration: (...args) => configurationWorkflow.importConfiguration(...args),
		applyConfiguration: (...args) => configurationWorkflow.applyConfiguration(...args),
		recoverConfiguration: (...args) => configurationWorkflow.recoverConfiguration(...args),
		get: (...args) => browsingWorkflow.get(...args),
		cancel: (...args) => lifecycleWorkflow.cancel(...args),
	}
	const tasksWorkflow = createNotificationManagementTasks(state, workspace)
	const lifecycleWorkflow = createNotificationManagementLifecycle(state, actions, workspace)
	const browsingWorkflow = createNotificationManagementBrowsing(state, actions)
	const mutationsWorkflow = createNotificationManagementMutations(state, actions)
	const configurationWorkflow = createNotificationManagementConfiguration(state, actions)
	const {
		reset,
		task,
		run,
		connect,
		disconnect,
		list,
		listPolicies,
		select,
		refresh,
		change,
		recover,
		afterChange,
		importConfiguration,
		applyConfiguration,
		recoverConfiguration,
		get,
		cancel,
	} = actions
	return {
		configPreview,
		configFileName,
		configOutcome,
		configReviewed,
		importConfiguration,
		applyConfiguration,
		recoverConfiguration,
		connection,
		busy,
		operationId,
		error,
		hubs,
		selected,
		details,
		policies,
		outcome,
		reviewed,
		blocked,
		reset,
		task,
		run,
		connect,
		disconnect,
		list,
		listPolicies,
		get,
		select,
		refresh,
		change,
		recover,
		afterChange,
		cancel,
	}
})
