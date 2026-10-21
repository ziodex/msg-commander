import { notificationHubsApi } from '@/features/notification-hubs/api'
import type { DesktopResult } from '@shared/contracts'
import {
	type NotificationHubRegistrationChange,
	type NotificationHubRegistrationOutcome,
} from '@shared/contracts/notification-hubs/registrations'
import type { RegistrationActions } from '../../model/registration-actions'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationMutations(
	state: Pick<
		RegistrationState,
		| 'connection'
		| 'busy'
		| 'error'
		| 'details'
		| 'query'
		| 'editor'
		| 'outcome'
		| 'reviewed'
		| 'blocked'
	>,
	actions: Pick<RegistrationActions, 'task' | 'search'>,
) {
	const { connection, busy, error, details, query, editor, outcome, reviewed, blocked } = state
	const { task, search } = actions
	async function openEditor(action: 'create' | 'update' | 'delete', snapshotId?: string) {
		if (blocked.value || !connection.value) return
		outcome.value = undefined
		reviewed.value = false
		if (action === 'create') {
			details.value = undefined
			editor.value = { action }
			return
		}
		if (!snapshotId) return
		await task(
			'Reload registration for ' + action,
			(id) =>
				notificationHubsApi.getNotificationHubRegistration({
					id,
					connectionId: connection.value!.connectionId,
					snapshotId,
				}),
			(value) => {
				details.value = undefined
				editor.value = { action, details: value }
			},
		)
	}
	async function reloadEditor() {
		const current = editor.value
		if (!current?.details || blocked.value) return
		const next = await task('Reload current registration', (id) =>
			notificationHubsApi.getNotificationHubRegistration({
				id,
				connectionId: connection.value!.connectionId,
				snapshotId: current.details!.registration.snapshotId,
			}),
		)
		if (next) {
			editor.value = { action: current.action, details: next }
			outcome.value = undefined
			reviewed.value = false
		}
	}
	async function change(setup: Omit<NotificationHubRegistrationChange, 'id' | 'connectionId'>) {
		if (blocked.value || !connection.value) return
		reviewed.value = false
		return task(
			'Registration ' + setup.action,
			async (id) => {
				try {
					const result = await notificationHubsApi.changeNotificationHubRegistration({
						...setup,
						draft: setup.draft
							? { rawXml: setup.draft.rawXml, tags: [...setup.draft.tags] }
							: null,
						id,
						connectionId: connection.value!.connectionId,
					})
					if (
						result.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
							'INVALID_REQUEST',
						].includes(result.error.code)
					)
						return result
				} catch {
					// A lost response does not prove rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						action: setup.action,
						status: 'unknown',
						summary:
							'Final response unavailable. Check the retained receipt and Azure state before another write. Nothing was retried.',
						registrationId:
							setup.action === 'create'
								? null
								: (editor.value?.details?.registration.registrationId ?? null),
						etag: null,
						snapshotId: null,
					},
				} satisfies DesktopResult<NotificationHubRegistrationOutcome>
			},
			(value) => {
				outcome.value = value
			},
			(value) => ({
				status:
					value.status === 'confirmed'
						? 'completed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: value.summary + ' Receipt: ' + value.operationId,
			}),
		)
	}
	async function recover() {
		if (!connection.value || !outcome.value) return
		const receiptId = outcome.value.operationId
		const value = await task('Check registration receipt', (id) =>
			notificationHubsApi.getNotificationHubRegistrationResult({
				id,
				connectionId: connection.value!.connectionId,
				operationId: receiptId,
			}),
		)
		if (value) {
			outcome.value = value
			reviewed.value = false
		} else if (value === null)
			error.value =
				'No retained receipt is available. Review Azure state; this does not prove the change failed.'
	}
	async function closeEditor() {
		if (busy.value) return
		const refresh = outcome.value?.status === 'confirmed'
		editor.value = undefined
		if (refresh) await search({ ...query.value })
	}
	return { openEditor, reloadEditor, change, recover, closeEditor }
}
