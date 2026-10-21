import { notificationHubsApi } from '@/features/notification-hubs/api'
import type { DesktopResult } from '@shared/contracts'
import type { RegistrationFileResult } from '@shared/contracts/notification-hubs/registration-files'
import type { RegistrationActions } from '../../model/registration-actions'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationFiles(
	state: Pick<
		RegistrationState,
		| 'connection'
		| 'busy'
		| 'error'
		| 'query'
		| 'filePreview'
		| 'fileName'
		| 'fileDetails'
		| 'fileOutcome'
		| 'fileReviewed'
		| 'blocked'
	>,
	actions: Pick<RegistrationActions, 'task' | 'search'>,
) {
	const {
		connection,
		busy,
		error,
		query,
		filePreview,
		fileName,
		fileDetails,
		fileOutcome,
		fileReviewed,
		blocked,
	} = state
	const { task, search } = actions
	async function importFile() {
		if (!connection.value || busy.value) return
		filePreview.value = undefined
		fileDetails.value = undefined
		fileName.value = ''
		return task(
			'Preview registration file',
			(id) =>
				notificationHubsApi.importNotificationHubRegistrations({
					id,
					connectionId: connection.value!.connectionId,
				}),
			(value) => {
				if (!value.cancelled && value.preview) {
					filePreview.value = value.preview
					fileName.value = value.fileName ?? ''
				}
			},
		)
	}
	async function inspectFile(entryId: string) {
		if (!connection.value || !filePreview.value) return
		const importId = filePreview.value.importId
		fileDetails.value = undefined
		return task(
			'Inspect imported registration',
			(id) =>
				notificationHubsApi.inspectNotificationHubRegistrationImport({
					id,
					connectionId: connection.value!.connectionId,
					importId,
					entryId,
				}),
			(value) => {
				fileDetails.value = value
			},
		)
	}
	async function exportFile(snapshotIds: string[], format: 'json' | 'xml') {
		if (!connection.value) return
		return task('Export registration snapshots', (id) =>
			notificationHubsApi.exportNotificationHubRegistrations({
				id,
				connectionId: connection.value!.connectionId,
				snapshotIds: [...snapshotIds],
				format,
			}),
		)
	}
	async function applyFile(entryIds: string[]) {
		if (blocked.value || !connection.value || !filePreview.value) return
		const importId = filePreview.value.importId
		fileReviewed.value = false
		const value = await task(
			'Import registrations',
			async (id) => {
				try {
					const response =
						await notificationHubsApi.applyNotificationHubRegistrationImport({
							id,
							connectionId: connection.value!.connectionId,
							importId,
							entryIds: [...entryIds],
							acknowledge: true,
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
					// Recover the aggregate receipt without replaying writes.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown',
						summary:
							'Final import response unavailable. Check the retained receipt and Azure state before another write. Nothing was retried.',
						steps: [],
					},
				} satisfies DesktopResult<RegistrationFileResult>
			},
			(result) => {
				fileOutcome.value = result
				filePreview.value = undefined
				fileDetails.value = undefined
			},
			(result) => ({
				status:
					result.status === 'completed'
						? 'completed'
						: result.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: result.summary + ' Receipt: ' + result.operationId,
			}),
		)
		if (value && value.status !== 'unknown') await search({ ...query.value })
		return value
	}
	async function recoverFile() {
		if (!connection.value || !fileOutcome.value) return
		const operationId = fileOutcome.value.operationId
		const result = await task('Check registration import receipt', (id) =>
			notificationHubsApi.getNotificationHubRegistrationImportResult({
				id,
				connectionId: connection.value!.connectionId,
				operationId,
			}),
		)
		if (result) {
			fileOutcome.value = result
			fileReviewed.value = false
		} else if (result === null)
			error.value =
				'No retained import receipt is available. Review Azure state; this does not prove the import failed.'
	}
	return { importFile, inspectFile, exportFile, applyFile, recoverFile }
}
