import { notificationHubsApi } from '@/features/notification-hubs/api'
import type { DesktopResult } from '@shared/contracts'
import type {
	NotificationDraft,
	NotificationOutcome,
} from '@shared/contracts/notification-hubs/notifications'
import type { SenderState } from '../../model/sender-state'
import type { NotificationTaskActions } from '../../model/task-actions'
export function createSenderSending(
	state: Pick<
		SenderState,
		'connection' | 'error' | 'outcome' | 'reviewed' | 'composer' | 'inspection' | 'blocked'
	>,
	actions: Pick<NotificationTaskActions, 'task'>,
) {
	const { connection, error, outcome, reviewed, composer, inspection, blocked } = state
	const { task } = actions
	async function send(value: NotificationDraft) {
		if (!connection.value || blocked.value) return
		const draft: NotificationDraft = {
			...value,
			parameters: value.parameters.map((p) => ({ ...p })),
			headers: value.headers.map((h) => ({ ...h })),
		}
		reviewed.value = false
		return task(
			'Test notification send',
			async (id) => {
				try {
					const result = await notificationHubsApi.sendTestNotification({
						id,
						connectionId: connection.value!.connectionId,
						draft,
						acknowledge: true,
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
					// The request may have been dispatched.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown',
						summary:
							'Final receipt unavailable. Check the retained receipt and device/provider state before another send. Nothing was retried.',
						capturedAt: new Date().toISOString(),
						draft,
						details: null,
					},
				} satisfies DesktopResult<NotificationOutcome>
			},
			(v) => {
				outcome.value = v
				composer.value = false
				inspection.value = true
			},
			(v) => ({
				status:
					v.status === 'confirmed'
						? 'completed'
						: v.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: v.summary + ' Receipt: ' + v.operationId,
			}),
		)
	}
	async function recover() {
		if (!connection.value || !outcome.value) return
		const receiptId = outcome.value.operationId
		await task(
			'Check test send receipt',
			(id) =>
				notificationHubsApi.getTestNotificationResult({
					id,
					connectionId: connection.value!.connectionId,
					operationId: receiptId,
				}),
			(value) => {
				if (value) outcome.value = value
				else
					error.value =
						'No retained receipt is available. Inspect device/provider state; recovery never resends.'
			},
		)
	}
	return { send, recover }
}
