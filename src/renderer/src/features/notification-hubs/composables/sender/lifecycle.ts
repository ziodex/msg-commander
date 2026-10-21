import { notificationHubsApi } from '@/features/notification-hubs/api'
import { useWorkspace } from '@/shared/workspace/store'
import type { NotificationSenderConnect } from '@shared/contracts/notification-hubs/notifications'
import type { SenderState } from '../../model/sender-state'
import type { NotificationTaskActions } from '../../model/task-actions'
export function createSenderLifecycle(
	state: Pick<
		SenderState,
		| 'connection'
		| 'busy'
		| 'operationId'
		| 'error'
		| 'outcome'
		| 'reviewed'
		| 'composer'
		| 'inspection'
		| 'lifetime'
	>,
	actions: Pick<NotificationTaskActions, 'task'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const {
		connection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		composer,
		inspection,
		lifetime,
	} = state
	const { task } = actions
	function reset() {
		lifetime.generation++
		connection.value = outcome.value = undefined
		busy.value = operationId.value = error.value = ''
		reviewed.value = composer.value = inspection.value = false
	}
	async function connect(setup: Omit<NotificationSenderConnect, 'id'>) {
		if (busy.value) return
		reset()
		return task(
			'Connect notification sender',
			(id) =>
				notificationHubsApi.connectNotificationSender({
					...setup,
					policyTarget: setup.policyTarget
						? {
								scope: { ...setup.policyTarget.scope },
								policyName: setup.policyTarget.policyName,
							}
						: null,
					id,
				}),
			(v) => {
				connection.value = v
			},
		)
	}
	async function disconnect() {
		if (!connection.value || busy.value) return
		await task(
			'Disconnect notification sender',
			(id) =>
				notificationHubsApi.disconnectNotificationSender({
					id,
					connectionId: connection.value!.connectionId,
				}),
			reset,
		)
	}
	const cancel = () => operationId.value && workspace.cancel(operationId.value)
	return { reset, connect, disconnect, cancel }
}
