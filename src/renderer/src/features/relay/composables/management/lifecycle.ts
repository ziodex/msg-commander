import { relayApi } from '@/features/relay/api'
import { useWorkspace } from '@/shared/workspace/store'
import { relayNamespace, type RelayConnect } from '@shared/contracts/relay/core'
import type { RelayActions } from '../../model/management-actions'
import type { RelayState } from '../../model/management-state'
export function createRelayLifecycle(
	state: Pick<
		RelayState,
		| 'connection'
		| 'busy'
		| 'operationId'
		| 'error'
		| 'hybrid'
		| 'wcf'
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
	actions: Pick<RelayActions, 'task' | 'run' | 'refresh'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const {
		connection,
		busy,
		operationId,
		error,
		hybrid,
		wcf,
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
		connection.value = undefined
		busy.value = operationId.value = error.value = ''
		hybrid.value = { items: [], continuationToken: null }
		wcf.value = { items: [], continuationToken: null }
		selected.value = { ...relayNamespace }
		details.value = undefined
		policies.value = { items: [], continuationToken: null }
		outcome.value = undefined
		reviewed.value = false
		configPreview.value = configOutcome.value = undefined
		configFileName.value = ''
		configReviewed.value = false
	}
	async function connect(setup: Omit<RelayConnect, 'id'>) {
		if (busy.value) return
		reset()
		if (
			await task(
				'Connect Relay management',
				(id) => relayApi.connectRelay({ ...setup, id }),
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
			'Disconnect Relay',
			(id, connectionId) => relayApi.disconnectRelay({ id, connectionId }),
			reset,
		)
	}
	const cancel = () => operationId.value && workspace.cancel(operationId.value)
	return { reset, connect, disconnect, cancel }
}
