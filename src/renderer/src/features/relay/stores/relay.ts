import { useWorkspace } from '@/shared/workspace/store'
import { defineStore } from 'pinia'
import { createRelayBrowsing } from '../composables/management/browsing'
import { createRelayConfiguration } from '../composables/management/configuration'
import { createRelayLifecycle } from '../composables/management/lifecycle'
import { createRelayMutations } from '../composables/management/mutations'
import { createRelayTasks } from '../composables/management/tasks'
import type { RelayActions } from '../model/management-actions'
import { createRelayState } from '../model/management-state'
export const useRelay = defineStore('relay', () => {
	const workspace = useWorkspace(),
		state = createRelayState()
	const {
		connection,
		busy,
		operationId,
		error,
		hybrid,
		wcf,
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
	const actions: RelayActions = {
		task: (...args) => tasks.task(...args),
		run: (...args) => tasks.run(...args),
		reset: () => lifecycle.reset(),
		refresh: () => browsing.refresh(),
	}
	const tasks = createRelayTasks(state, workspace)
	const { task, run } = tasks
	const lifecycle = createRelayLifecycle(state, actions, workspace)
	const { reset, connect, disconnect, cancel } = lifecycle
	const browsing = createRelayBrowsing(state, actions)
	const { list, listPolicies, get, select, refresh } = browsing
	const mutations = createRelayMutations(state, actions)
	const { change, recover, afterChange } = mutations
	const configuration = createRelayConfiguration(state, actions)
	const { importConfiguration, applyConfiguration, recoverConfiguration } = configuration
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
		hybrid,
		wcf,
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
