import { defineStore } from 'pinia'
import { watch } from 'vue'

import { useWorkspace } from '@/shared/workspace/store'

import { createServiceBusState } from '../model/state'
import { createServiceBusTasks } from '../composables/tasks'
import { createServiceBusSelection } from '../composables/selection'
import { createServiceBusLifecycle } from '../composables/lifecycle'
import { createServiceBusNavigation } from '../composables/navigation'
import { createServiceBusInspection } from '../composables/inspection'
import { createServiceBusMaintenance } from '../composables/maintenance'
import { createServiceBusSettlement } from '../composables/settlement'
import { createServiceBusFiles } from '../composables/files'
import { createServiceBusSending } from '../composables/sending'
import { createServiceBusSessions } from '../composables/sessions'
import { createServiceBusAdministration } from '../composables/administration'

export const useServiceBus = defineStore('service-bus', () => {
	const workspace = useWorkspace()
	const state = createServiceBusState(workspace)
	const {
		connection,
		category,
		topicName,
		entities,
		currentToken,
		history,
		selected,
		selectionView,
		details,
		messages,
		message,
		body,
		bodyStart,
		nextBodyOffset,
		subQueue,
		fromSequence,
		pageSize,
		busy,
		error,
		filter,
		peekedFrom,
		held,
		outcome,
		purgeResult,
		purgeOperationId,
		purgeInterrupted,
		bulkPurgePlan,
		bulkPurgeResult,
		bulkPurgeOperationId,
		bulkPurgeInterrupted,
		bulkPurgeNeedsReview,
		resendResult,
		resendOperationId,
		resendInterrupted,
		visibleEntities,
		tabs,
		activeTabId,
		fileNotice,
	} = state
	const tasks = createServiceBusTasks(state)
	const selection = createServiceBusSelection(state)
	const operation = { ...tasks, ...selection }
	const inspection = createServiceBusInspection(state, operation)
	const navigation = createServiceBusNavigation(state, operation)
	const lifecycle = createServiceBusLifecycle(state, { ...operation, ...navigation })
	const maintenance = createServiceBusMaintenance(state, operation)
	const settlement = createServiceBusSettlement(state, operation)
	const files = createServiceBusFiles(state, tasks)
	const sending = createServiceBusSending(state, { ...operation, ...settlement })
	const sessions = createServiceBusSessions(state, { ...operation, ...settlement })
	const administration = createServiceBusAdministration(state, {
		...operation,
		...navigation,
		...settlement,
	})
	const actions = {
		...operation,
		...inspection,
		...navigation,
		...lifecycle,
		...maintenance,
		...settlement,
		...files,
		...sending,
		...sessions,
		...administration,
	}
	const {
		previewBulkPurge,
		bulkPurgeMessages,
		checkBulkPurgeResult,
		resendDeadLetters,
		checkResendResult,
		purgeMessages,
		checkPurgeResult,
		activateTab,
		closeTab,
		clearEntity,
		reset,
		connect,
		disconnect,
		browse,
		refreshEntity,
		select,
		peek,
		changeSubQueue,
		inspect,
		readBody,
		bodyWindow,
		refreshHeld,
		receive,
		closeReceiver,
		exportMessages,
		saveDrafts,
		importMessages,
		loadImported,
		discardImport,
		sendBatch,
		listScheduled,
		cancelScheduled,
		send,
		listSessions,
		closeSessionScan,
		acceptSession,
		getSessionState,
		setSessionState,
		renewSession,
		releaseSession,
		listRules,
		getRule,
		manageRule,
		getConfiguration,
		manageEntity,
		settle,
		resendSnapshot,
		replay,
		checkOutcome,
	} = actions
	watch(
		() => workspace.preferences.peekCount,
		(value) => {
			pageSize.value = value
		},
	)
	return {
		tabs,
		activeTabId,
		activateTab,
		closeTab,
		clearEntity,
		bulkPurgePlan,
		bulkPurgeResult,
		bulkPurgeOperationId,
		bulkPurgeInterrupted,
		bulkPurgeNeedsReview,
		previewBulkPurge,
		bulkPurgeMessages,
		checkBulkPurgeResult,
		purgeMessages,
		resendDeadLetters,
		checkResendResult,
		resendResult,
		resendOperationId,
		resendInterrupted,
		checkPurgeResult,
		purgeResult,
		purgeOperationId,
		purgeInterrupted,
		listRules,
		getRule,
		manageRule,
		getConfiguration,
		manageEntity,
		held,
		outcome,
		refreshHeld,
		receive,
		closeReceiver,
		send,
		sendBatch,
		listSessions,
		closeSessionScan,
		acceptSession,
		getSessionState,
		setSessionState,
		renewSession,
		releaseSession,
		fileNotice,
		exportMessages,
		saveDrafts,
		importMessages,
		loadImported,
		discardImport,
		listScheduled,
		cancelScheduled,
		settle,
		replay,
		resendSnapshot,
		checkOutcome,
		connection,
		category,
		topicName,
		entities,
		visibleEntities,
		currentToken,
		history,
		selected,
		selectionView,
		details,
		messages,
		message,
		body,
		bodyStart,
		nextBodyOffset,
		subQueue,
		fromSequence,
		pageSize,
		peekedFrom,
		filter,
		busy,
		error,
		connect,
		disconnect,
		browse,
		refreshEntity,
		select,
		peek,
		inspect,
		readBody,
		bodyWindow,
		changeSubQueue,
		reset,
	}
})
