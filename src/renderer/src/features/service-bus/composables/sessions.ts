import { serviceBusApi } from '@/features/service-bus/api'

import type { SessionPage, SessionState } from '@shared/sessions'

import type { PeekTarget } from '@shared/service-bus'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'
import type { createServiceBusSettlement } from './settlement'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearInspection'> &
	Pick<ReturnType<typeof createServiceBusSettlement>, 'refreshHeld' | 'write'>

export function createServiceBusSessions(
	state: Pick<ServiceBusState, 'busy' | 'connection' | 'error' | 'held'>,
	actions: ServiceBusDependencies,
) {
	const { busy, connection, error, held } = state
	const { clearInspection, refreshHeld, task, write } = actions
	async function listSessions(target: PeekTarget, continuationToken: string | null = null) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let page: SessionPage | undefined
		await task(
			'List sessions',
			(id) =>
				serviceBusApi.listSessions({
					id,
					connectionId,
					target: { ...target },
					continuationToken,
				}),
			(value) => {
				page = value
			},
		)
		return page
	}
	function closeSessionScan(continuationToken: string) {
		if (connection.value)
			void serviceBusApi.closeSessionScan({
				id: crypto.randomUUID(),
				connectionId: connection.value.connectionId,
				continuationToken,
			})
	}
	async function acceptSession(target: PeekTarget, sessionId: string) {
		if (!connection.value || busy.value) return false
		const connectionId = connection.value.connectionId
		const accepted = await task(
			'Accept exclusive session lock',
			(id) =>
				serviceBusApi.acceptSession({ id, connectionId, target: { ...target }, sessionId }),
			(value) => {
				held.value = value
			},
		)
		const operationError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (operationError) error.value = operationError
		}
		return accepted
	}
	async function getSessionState(leaseId: string) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let state: SessionState | undefined
		await task(
			'Read session state',
			(id) => serviceBusApi.getSessionState({ id, connectionId, leaseId }),
			(value) => {
				state = value
			},
		)
		const operationError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (operationError) error.value = operationError
		}
		return state
	}
	async function setSessionState(
		leaseId: string,
		bodyBase64: string | null,
		expectedRevision: string,
		confirmation = '',
	) {
		return write(
			bodyBase64 === null ? 'Clear session state' : 'Save session state',
			(id, connectionId) =>
				serviceBusApi.setSessionState({
					id,
					connectionId,
					leaseId,
					bodyBase64,
					expectedRevision,
					confirmation,
				}),
		)
	}
	async function renewSession(leaseId: string) {
		return write('Renew session lock', (id, connectionId) =>
			serviceBusApi.renewSessionLock({ id, connectionId, leaseId }),
		)
	}
	async function releaseSession(leaseId: string) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Release session receiver',
			(id) => serviceBusApi.releaseSession({ id, connectionId, leaseId }),
			() => {
				clearInspection()
			},
		)
		const operationError = error.value
		if (connection.value?.connectionId === connectionId) {
			await refreshHeld()
			if (operationError) error.value = operationError
		}
	}
	return {
		listSessions,
		closeSessionScan,
		acceptSession,
		getSessionState,
		setSessionState,
		renewSession,
		releaseSession,
	}
}
