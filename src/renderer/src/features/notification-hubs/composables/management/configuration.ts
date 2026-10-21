import { notificationHubsApi } from '@/features/notification-hubs/api'
import type { NotificationHubConfigResult } from '@shared/contracts/notification-hubs/configuration'

import type { DesktopResult } from '@shared/contracts'

import type { NotificationManagementState } from '../../model/management-state'
import type { NotificationManagementActions } from '../../model/management-actions'

export function createNotificationManagementConfiguration(
	state: Pick<
		NotificationManagementState,
		| 'busy'
		| 'error'
		| 'configPreview'
		| 'configFileName'
		| 'configOutcome'
		| 'configReviewed'
		| 'blocked'
	>,
	actions: Pick<NotificationManagementActions, 'run' | 'refresh'>,
) {
	const { busy, error, configPreview, configFileName, configOutcome, configReviewed, blocked } =
		state
	const { run, refresh } = actions
	async function importConfiguration() {
		if (busy.value) return
		configPreview.value = undefined
		configFileName.value = ''
		const value = await run('Preview Notification Hubs configuration', (id, connectionId) =>
			notificationHubsApi.importNotificationHubConfiguration({ id, connectionId }),
		)
		if (value && !value.cancelled && value.preview) {
			configPreview.value = value.preview
			configFileName.value = value.fileName ?? ''
		}
		return value
	}
	async function applyConfiguration(entryIds: string[]) {
		if (blocked.value || !configPreview.value) return
		const importId = configPreview.value.importId
		configReviewed.value = false
		const result = await run(
			'Import Notification Hubs configuration',
			async (id, connectionId) => {
				try {
					const response = await notificationHubsApi.applyNotificationHubConfiguration({
						id,
						connectionId,
						importId,
						entryIds: [...entryIds],
						acknowledged: true,
					})
					if (
						response.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
							'INVALID_REQUEST',
						].includes(response.error.code)
					)
						return response
				} catch {
					// Recover the aggregate receipt rather than repeat a write.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown',
						summary:
							'The final import response is unavailable. Check the retained receipt and Azure state before another change. Nothing was retried.',
						steps: [],
					},
				} satisfies DesktopResult<NotificationHubConfigResult>
			},
			(value) => {
				configOutcome.value = value
				configPreview.value = undefined
			},
			(value) => ({
				status:
					value.status === 'completed'
						? 'completed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: value.summary + ' Receipt: ' + value.operationId,
			}),
		)
		if (result && result.status !== 'unknown') await refresh()
		return result
	}
	async function recoverConfiguration() {
		if (!configOutcome.value) return
		const operation = configOutcome.value.operationId
		const value = await run('Check Notification Hubs import receipt', (id, connectionId) =>
			notificationHubsApi.getNotificationHubConfigurationResult({
				id,
				connectionId,
				operationId: operation,
			}),
		)
		if (value) {
			configOutcome.value = value
			configReviewed.value = false
		} else if (value === null)
			error.value =
				'No retained import receipt is available. Review Azure state; this does not prove the import failed.'
	}
	return { importConfiguration, applyConfiguration, recoverConfiguration }
}
