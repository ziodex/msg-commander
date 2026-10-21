import { notificationHubsApi } from '@/features/notification-hubs/api'

import { useWorkspace } from '@/shared/workspace/store'

import { nhNamespace, type NotificationHubConnect } from '@shared/contracts/notification-hubs/core'
import type { NotificationManagementState } from '../../model/management-state'
import type { NotificationManagementActions } from '../../model/management-actions'

export function createNotificationManagementLifecycle(
	state: Pick<
		NotificationManagementState,
		| 'connection'
		| 'busy'
		| 'operationId'
		| 'error'
		| 'hubs'
		| 'selected'
		| 'details'
		| 'policies'
		| 'outcome'
		| 'reviewed'
		| 'configPreview'
		| 'configFileName'
		| 'configOutcome'
		| 'configReviewed'
		| 'lifetime'
	>,
	actions: Pick<NotificationManagementActions, 'task' | 'run' | 'refresh'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
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
		lifetime,
	} = state
	const { task, run, refresh } = actions
	function reset() {
		lifetime.generation++
		configPreview.value = undefined
		configFileName.value = ''
		configOutcome.value = undefined
		configReviewed.value = false
		connection.value = undefined
		busy.value = operationId.value = error.value = ''
		hubs.value = { items: [], continuationToken: null }
		selected.value = { ...nhNamespace }
		details.value = undefined
		policies.value = { items: [], continuationToken: null }
		outcome.value = undefined
		reviewed.value = false
	}
	async function connect(setup: Omit<NotificationHubConnect, 'id'>) {
		if (busy.value) return
		reset()
		if (
			await task(
				'Connect Notification Hubs management',
				(id) => notificationHubsApi.connectNotificationHub({ ...setup, id }),
				(v) => {
					connection.value = v
				},
			)
		) {
			await refresh()
		}
	}
	async function disconnect() {
		await run(
			'Disconnect Notification Hubs',
			(id, connectionId) =>
				notificationHubsApi.disconnectNotificationHub({ id, connectionId }),
			reset,
		)
	}
	const cancel = () => operationId.value && workspace.cancel(operationId.value)
	return { reset, connect, disconnect, cancel }
}
