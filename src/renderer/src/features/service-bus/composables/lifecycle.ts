import { serviceBusApi } from '@/features/service-bus/api'

import { readEntityTabs } from '@/features/service-bus/lib/entity-tabs'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'
import type { createServiceBusNavigation } from './navigation'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearEntity'> &
	Pick<ReturnType<typeof createServiceBusNavigation>, 'browse'>

export function createServiceBusLifecycle(
	state: Pick<
		ServiceBusState,
		| 'activeTabId'
		| 'bulkPurgeInterrupted'
		| 'bulkPurgeNeedsReview'
		| 'bulkPurgeOperationId'
		| 'bulkPurgePlan'
		| 'bulkPurgeResult'
		| 'busy'
		| 'category'
		| 'connection'
		| 'currentToken'
		| 'entities'
		| 'error'
		| 'fileNotice'
		| 'generation'
		| 'held'
		| 'history'
		| 'outcome'
		| 'purgeInterrupted'
		| 'purgeOperationId'
		| 'purgeResult'
		| 'resendInterrupted'
		| 'resendOperationId'
		| 'resendResult'
		| 'tabs'
		| 'topicName'
		| 'workspace'
	>,
	actions: ServiceBusDependencies,
) {
	const {
		activeTabId,
		bulkPurgeInterrupted,
		bulkPurgeNeedsReview,
		bulkPurgeOperationId,
		bulkPurgePlan,
		bulkPurgeResult,
		busy,
		category,
		connection,
		currentToken,
		entities,
		error,
		fileNotice,
		generation,
		held,
		history,
		outcome,
		purgeInterrupted,
		purgeOperationId,
		purgeResult,
		resendInterrupted,
		resendOperationId,
		resendResult,
		tabs,
		topicName,
		workspace,
	} = state
	const { browse, clearEntity, task } = actions
	function reset() {
		tabs.value = []
		activeTabId.value = ''
		fileNotice.value = ''
		resendResult.value = undefined
		resendOperationId.value = ''
		resendInterrupted.value = false
		purgeResult.value = undefined
		purgeOperationId.value = ''
		purgeInterrupted.value = false
		bulkPurgePlan.value = undefined
		bulkPurgeResult.value = undefined
		bulkPurgeOperationId.value = ''
		bulkPurgeInterrupted.value = false
		bulkPurgeNeedsReview.value = false
		generation.current++
		connection.value = undefined
		entities.value = { items: [], continuationToken: null }
		category.value = 'queue'
		topicName.value = undefined
		history.value = []
		currentToken.value = null
		error.value = ''
		busy.value = ''
		clearEntity()
		held.value = { target: null, subQueue: 'active', sessionId: null, items: [], warning: null }
		outcome.value = undefined
	}
	async function connect(profileId: string) {
		if (busy.value) return
		reset()
		if (
			await task(
				'Connect to namespace',
				(id) => serviceBusApi.connectNamespace({ id, profileId }),
				(value) => {
					connection.value = value
				},
			)
		) {
			await browse('queue')
			tabs.value = readEntityTabs(profileId, workspace.preferences.peekCount)
		}
	}
	async function disconnect() {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Disconnect namespace',
			(id) => serviceBusApi.disconnectNamespace({ id, connectionId }),
			reset,
		)
	}
	return { reset, connect, disconnect }
}
