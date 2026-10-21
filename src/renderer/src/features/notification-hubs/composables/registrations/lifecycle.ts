import { notificationHubsApi } from '@/features/notification-hubs/api'
import { useWorkspace } from '@/shared/workspace/store'
import {
	defaultRegistrationQuery,
	type NotificationHubRegistrationsConnect,
} from '@shared/contracts/notification-hubs/registrations'
import type { RegistrationActions } from '../../model/registration-actions'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationLifecycle(
	state: Pick<
		RegistrationState,
		| 'connection'
		| 'busy'
		| 'operationId'
		| 'error'
		| 'page'
		| 'details'
		| 'query'
		| 'editor'
		| 'outcome'
		| 'reviewed'
		| 'filePreview'
		| 'fileName'
		| 'fileDetails'
		| 'fileOutcome'
		| 'fileReviewed'
		| 'jobReview'
		| 'jobOutcome'
		| 'jobPage'
		| 'selectedJob'
		| 'jobReviewed'
		| 'pageNumber'
		| 'lifetime'
	>,
	actions: Pick<RegistrationActions, 'task' | 'search'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const {
		connection,
		busy,
		operationId,
		error,
		page,
		details,
		query,
		editor,
		outcome,
		reviewed,
		filePreview,
		fileName,
		fileDetails,
		fileOutcome,
		fileReviewed,
		jobReview,
		jobOutcome,
		jobPage,
		selectedJob,
		jobReviewed,
		pageNumber,
		lifetime,
	} = state
	const { task, search } = actions
	function reset() {
		lifetime.generation++
		jobReview.value = undefined
		jobOutcome.value = undefined
		jobPage.value = undefined
		selectedJob.value = undefined
		jobReviewed.value = false
		filePreview.value = undefined
		fileName.value = ''
		fileDetails.value = undefined
		fileOutcome.value = undefined
		fileReviewed.value = false
		connection.value = page.value = details.value = undefined
		busy.value = operationId.value = error.value = ''
		editor.value = outcome.value = undefined
		reviewed.value = false
		query.value = defaultRegistrationQuery()
		pageNumber.value = 0
		lifetime.cursors = []
	}
	async function connect(setup: Omit<NotificationHubRegistrationsConnect, 'id'>) {
		if (busy.value) return
		reset()
		const ticket = lifetime.generation
		const result = await task(
			'Connect Notification Hubs registrations',
			(id) =>
				notificationHubsApi.connectNotificationHubRegistrations({
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
		if (result && ticket === lifetime.generation) await search(defaultRegistrationQuery())
	}
	async function disconnect() {
		if (!connection.value) return
		await task(
			'Disconnect registrations',
			(id) =>
				notificationHubsApi.disconnectNotificationHubRegistrations({
					id,
					connectionId: connection.value!.connectionId,
				}),
			reset,
		)
	}
	const cancel = () => operationId.value && workspace.cancel(operationId.value)
	return { reset, connect, disconnect, cancel }
}
