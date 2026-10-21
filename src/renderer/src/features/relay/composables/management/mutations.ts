import { relayApi } from '@/features/relay/api'
import type { DesktopResult } from '@shared/contracts'
import { relayNamespace, type RelayChange, type RelayOutcome } from '@shared/contracts/relay/core'
import type { RelayActions } from '../../model/management-actions'
import type { RelayState } from '../../model/management-state'
export function createRelayMutations(
	state: Pick<RelayState, 'error' | 'selected' | 'outcome' | 'reviewed' | 'blocked'>,
	actions: Pick<RelayActions, 'run' | 'refresh'>,
) {
	const { error, selected, outcome, reviewed, blocked } = state
	const { run, refresh } = actions
	async function change(setup: Omit<RelayChange, 'id' | 'connectionId'>) {
		if (blocked.value) return
		reviewed.value = false
		return run(
			'Relay: ' + setup.action,
			async (id, connectionId) => {
				try {
					const response = await relayApi.changeRelayResource({
						...setup,
						id,
						connectionId,
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
					// A missing response does not prove rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						target: setup.target,
						action: setup.action,
						status: 'unknown',
						summary:
							'The final response is unavailable. Check the retained receipt and Azure state before another change. Nothing was retried.',
					},
				} satisfies DesktopResult<RelayOutcome>
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
				message: `${value.summary} Receipt: ${value.operationId}`,
			}),
		)
	}
	async function recover() {
		if (!outcome.value) return
		const operation = outcome.value.operationId
		const value = await run('Check Relay receipt', (id, connectionId) =>
			relayApi.getRelayResult({ id, connectionId, operationId: operation }),
		)
		if (value) {
			outcome.value = value
			reviewed.value = false
		} else if (value === null)
			error.value =
				'No retained receipt is available. Review Azure state; this does not prove the change failed.'
	}
	async function afterChange(value: RelayOutcome) {
		if (value.status !== 'confirmed') return
		if (value.target.policyName === null && value.action !== 'delete')
			selected.value = { ...value.target.scope }
		if (
			value.action === 'delete' &&
			value.target.policyName === null &&
			selected.value.kind === value.target.scope.kind &&
			selected.value.name === value.target.scope.name
		)
			selected.value = { ...relayNamespace }
		await refresh()
	}
	return { change, recover, afterChange }
}
