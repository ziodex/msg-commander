import { serviceBusApi } from '@/features/service-bus/api'

import { type MessageSubQueue } from '@shared/service-bus'

import type { PeekTarget } from '@shared/service-bus'

import type {
	OperationOutcome,
	ReplayRequest,
	SendTarget,
	SettleRequest,
} from '@shared/message-operations'

import type { DesktopResult } from '@shared/contracts'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearInspection'>

export function createServiceBusSettlement(
	state: Pick<
		ServiceBusState,
		'busy' | 'connection' | 'error' | 'held' | 'outcome' | 'selected' | 'subQueue'
	>,
	actions: ServiceBusDependencies,
) {
	const { busy, connection, error, held, outcome, selected, subQueue } = state
	const { clearInspection, task } = actions
	async function refreshHeld() {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Refresh held messages',
			(id) => serviceBusApi.listDeliveries({ id, connectionId }),
			(value) => {
				held.value = value
			},
		)
	}
	async function receive(
		maxMessages: number,
		waitSeconds: number,
		sessionId: string,
		deferredSequence?: string,
		sessionLeaseId?: string,
		source?: { target: PeekTarget; subQueue: MessageSubQueue },
	) {
		if (
			!connection.value ||
			(!source && (!selected.value || selected.value.target.kind === 'topic')) ||
			busy.value
		)
			return
		const connectionId = connection.value.connectionId
		const target = { ...(source?.target ?? selected.value!.target) } as PeekTarget
		const receiveSubQueue = source?.subQueue ?? subQueue.value
		await task(
			'Receive and lock messages',
			(id) =>
				serviceBusApi.receiveMessages({
					id,
					connectionId,
					target,
					subQueue: receiveSubQueue,
					maxMessages,
					waitSeconds,
					sessionId: receiveSubQueue !== 'active' ? '' : sessionId,
					...(deferredSequence ? { deferredSequence } : {}),
					...(sessionLeaseId ? { sessionLeaseId } : {}),
				}),
			(value) => {
				held.value = value
			},
		)
		// A cancelled receive can still own messages. Recover that state, without receiving again.
		const receiveError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (receiveError)
				error.value =
					receiveError + ' Check held messages for locks acquired before interruption.'
		}
	}
	async function closeReceiver() {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		if (
			await task(
				'Close receiver; outstanding locks expire',
				(id) => serviceBusApi.closeReceiver({ id, connectionId }),
				() => {
					clearInspection()
				},
			)
		)
			await refreshHeld()
	}
	async function write(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<OperationOutcome>>,
	): Promise<OperationOutcome | undefined> {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		outcome.value = undefined
		await task(
			label,
			async (id) => {
				const result = await action(id, connectionId)
				if (
					!result.ok &&
					['OUTCOME_UNKNOWN', 'TIMEOUT', 'CANCELLED', 'BACKEND_UNAVAILABLE'].includes(
						result.error.code,
					)
				)
					return {
						ok: true as const,
						value: {
							operationId: id,
							status: 'unknown' as const,
							summary: result.error.message + ' Check outcome before retrying.',
							messageId: null,
						},
					}
				return result
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
				message: `${value.summary} Receipt: ${value.operationId}${value.messageId ? ' · Message ID: ' + value.messageId : ''}`,
			}),
		)
		const writeError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (writeError) error.value = writeError
		}
		return outcome.value
	}
	async function settle(
		deliveryId: string,
		action: SettleRequest['action'],
		reason = '',
		description = '',
	) {
		return write('Settle message: ' + action, (id, connectionId) =>
			serviceBusApi.settleMessage({
				id,
				connectionId,
				deliveryId,
				action,
				reason,
				description,
			}),
		)
	}
	async function resendSnapshot(
		snapshotId: string,
		destination: SendTarget,
		idPolicy: ReplayRequest['idPolicy'],
		messageId: string,
	) {
		return write('Resend message copy', (id, connectionId) =>
			serviceBusApi.resendSnapshot({
				id,
				connectionId,
				snapshotId,
				destination: { ...destination },
				idPolicy,
				messageId,
			}),
		)
	}
	async function replay(
		deliveryId: string,
		destination: SendTarget,
		idPolicy: ReplayRequest['idPolicy'],
		messageId: string,
	) {
		return write('Replay dead-letter message', (id, connectionId) =>
			serviceBusApi.replayMessage({
				id,
				connectionId,
				deliveryId,
				destination: { ...destination },
				idPolicy,
				messageId,
			}),
		)
	}
	async function checkOutcome() {
		if (!connection.value || !outcome.value || busy.value) return
		const connectionId = connection.value.connectionId,
			operationId = outcome.value.operationId
		await task(
			'Check operation outcome',
			(id) => serviceBusApi.getOperationOutcome({ id, connectionId, operationId }),
			(value) => {
				if (value) outcome.value = value
				else
					error.value =
						'No receipt is available in this connection. Verify the broker state; do not assume the operation failed.'
			},
		)
		const checkError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (checkError) error.value = checkError
		}
	}
	return {
		refreshHeld,
		receive,
		closeReceiver,
		write,
		settle,
		resendSnapshot,
		replay,
		checkOutcome,
	}
}
