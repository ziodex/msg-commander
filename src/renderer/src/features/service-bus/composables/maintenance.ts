import { serviceBusApi } from '@/features/service-bus/api'

import type { BulkPurgePreviewRequest } from '@shared/contracts/service-bus/maintenance'

import type { PurgeRequest } from '@shared/contracts/service-bus/maintenance'
import type { ResendRequest } from '@shared/contracts/service-bus/maintenance'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearInspection'>

export function createServiceBusMaintenance(
	state: Pick<
		ServiceBusState,
		| 'bulkPurgeInterrupted'
		| 'bulkPurgeNeedsReview'
		| 'bulkPurgeOperationId'
		| 'bulkPurgePlan'
		| 'bulkPurgeResult'
		| 'busy'
		| 'connection'
		| 'error'
		| 'generation'
		| 'messages'
		| 'purgeInterrupted'
		| 'purgeOperationId'
		| 'purgeResult'
		| 'resendInterrupted'
		| 'resendOperationId'
		| 'resendResult'
	>,
	actions: ServiceBusDependencies,
) {
	const {
		bulkPurgeInterrupted,
		bulkPurgeNeedsReview,
		bulkPurgeOperationId,
		bulkPurgePlan,
		bulkPurgeResult,
		busy,
		connection,
		error,
		generation,
		messages,
		purgeInterrupted,
		purgeOperationId,
		purgeResult,
		resendInterrupted,
		resendOperationId,
		resendResult,
	} = state
	const { clearInspection, task } = actions
	async function previewBulkPurge(input: Omit<BulkPurgePreviewRequest, 'id' | 'connectionId'>) {
		if (
			!connection.value ||
			busy.value ||
			bulkPurgeInterrupted.value ||
			bulkPurgeNeedsReview.value ||
			purgeInterrupted.value
		)
			return false
		const connectionId = connection.value.connectionId
		bulkPurgePlan.value = undefined
		return await task(
			'Review bulk purge',
			(id) => serviceBusApi.previewBulkPurge({ ...input, id, connectionId }),
			(value) => {
				bulkPurgePlan.value = value
				bulkPurgeResult.value = undefined
			},
		)
	}
	async function bulkPurgeMessages(confirmation: string) {
		if (
			!connection.value ||
			!bulkPurgePlan.value ||
			busy.value ||
			bulkPurgeInterrupted.value ||
			bulkPurgeNeedsReview.value ||
			purgeInterrupted.value
		)
			return
		const connectionId = connection.value.connectionId,
			planId = bulkPurgePlan.value.planId,
			ticket = generation.current
		bulkPurgeResult.value = undefined
		await task(
			'Bulk purge messages',
			async (id) => {
				bulkPurgeOperationId.value = id
				try {
					const response = await serviceBusApi.bulkPurgeMessages({
						id,
						connectionId,
						planId,
						confirmation,
					})
					if (ticket === generation.current && !response.ok)
						bulkPurgeInterrupted.value = response.error.code === 'OUTCOME_UNKNOWN'
					return response
				} catch (error) {
					if (ticket === generation.current) bulkPurgeInterrupted.value = true
					throw error
				}
			},
			(result) => {
				bulkPurgeResult.value = result
				bulkPurgeNeedsReview.value = result.status === 'unknown'
			},
			(result) => ({
				status:
					result.status === 'cancelled'
						? 'cancelled'
						: ['failed', 'unknown'].includes(result.status)
							? 'failed'
							: 'completed',
				message: result.summary,
			}),
		)
		if (ticket !== generation.current) return
		messages.value = undefined
		clearInspection()
	}
	async function checkBulkPurgeResult() {
		if (!connection.value || !bulkPurgeOperationId.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Check bulk purge result',
			(id) =>
				serviceBusApi.getBulkPurgeResult({
					id,
					connectionId,
					operationId: bulkPurgeOperationId.value,
				}),
			(result) => {
				if (result) {
					bulkPurgeResult.value = result
					bulkPurgeInterrupted.value = false
					bulkPurgeNeedsReview.value = result.status === 'unknown'
				} else
					error.value =
						'No retained bulk purge result is available. Review all selected targets before reconnecting; missing results do not mean nothing was deleted.'
			},
		)
	}
	async function resendDeadLetters(input: Omit<ResendRequest, 'id' | 'connectionId'>) {
		if (!connection.value || busy.value || resendInterrupted.value) return
		const connectionId = connection.value.connectionId,
			ticket = generation.current
		resendResult.value = undefined
		await task(
			'Resend dead-letter messages',
			async (id) => {
				resendOperationId.value = id
				try {
					const response = await serviceBusApi.resendDeadLetters({
						...input,
						id,
						connectionId,
					})
					if (ticket === generation.current && !response.ok)
						resendInterrupted.value = response.error.code === 'OUTCOME_UNKNOWN'
					return response
				} catch (error) {
					if (ticket === generation.current) resendInterrupted.value = true
					throw error
				}
			},
			(result) => {
				resendResult.value = result
			},
			(result) => ({
				status:
					result.status === 'cancelled'
						? 'cancelled'
						: ['failed', 'unknown'].includes(result.status)
							? 'failed'
							: 'completed',
				message: result.summary,
			}),
		)
		if (ticket !== generation.current) return
		messages.value = undefined
		clearInspection()
	}
	async function checkResendResult() {
		if (!connection.value || !resendOperationId.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Check resend result',
			(id) =>
				serviceBusApi.getResendResult({
					id,
					connectionId,
					operationId: resendOperationId.value,
				}),
			(result) => {
				if (result) {
					resendResult.value = result
					resendInterrupted.value = false
				} else
					error.value =
						'No retained resend result is available. Inspect the source and destination before reconnecting or retrying.'
			},
		)
	}
	async function purgeMessages(input: Omit<PurgeRequest, 'id' | 'connectionId'>) {
		if (
			!connection.value ||
			busy.value ||
			purgeInterrupted.value ||
			bulkPurgeInterrupted.value ||
			bulkPurgeNeedsReview.value
		)
			return
		const connectionId = connection.value.connectionId
		const ticket = generation.current
		purgeResult.value = undefined
		purgeInterrupted.value = false
		await task(
			'Purge messages',
			async (id) => {
				purgeOperationId.value = id
				try {
					const response = await serviceBusApi.purgeMessages({
						...input,
						id,
						connectionId,
					})
					if (ticket === generation.current && !response.ok)
						purgeInterrupted.value = response.error.code === 'OUTCOME_UNKNOWN'
					return response
				} catch (error) {
					if (ticket === generation.current) purgeInterrupted.value = true
					throw error
				}
			},
			(result) => {
				purgeResult.value = result
			},
			(result) => ({
				status:
					result.status === 'cancelled'
						? 'cancelled'
						: result.status === 'failed' || result.status === 'unknown'
							? 'failed'
							: 'completed',
				message: result.summary,
			}),
		)
		if (ticket !== generation.current) return
		messages.value = undefined
		clearInspection()
		// Results may be partial; invalidate the old page rather than implying it is current.
	}
	async function checkPurgeResult() {
		if (!connection.value || !purgeOperationId.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Check purge result',
			(id) =>
				serviceBusApi.getPurgeResult({
					id,
					connectionId,
					operationId: purgeOperationId.value,
				}),
			(result) => {
				if (result) {
					purgeResult.value = result
					purgeInterrupted.value = false
				} else
					error.value =
						'No retained result is available. Do not assume the purge deleted nothing. Reconnect only after reviewing the destination.'
			},
		)
	}
	return {
		previewBulkPurge,
		bulkPurgeMessages,
		checkBulkPurgeResult,
		resendDeadLetters,
		checkResendResult,
		purgeMessages,
		checkPurgeResult,
	}
}
