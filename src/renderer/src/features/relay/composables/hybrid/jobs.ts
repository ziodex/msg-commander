import { relayApi } from '@/features/relay/api'
import { useWorkspace } from '@/shared/workspace/store'
import type { HybridRun } from '@shared/contracts/relay/hybrid'
import type { HybridEntry, HybridState } from '../../model/hybrid-state'
export function createHybridJobs(state: HybridState, workspace: ReturnType<typeof useWorkspace>) {
	const { entries, lifetime, blocked, reset } = state
	async function run(setup: Omit<HybridRun, 'id'>) {
		if (blocked(setup.mode.endsWith('listen') ? 'listen' : 'send')) return
		const ticket = lifetime.generation
		try {
			await workspace.perform(
				`Hybrid Connection ${setup.mode}: ${setup.name}`,
				async (id) => {
					const entry: HybridEntry = {
						id,
						request: { ...JSON.parse(JSON.stringify(setup)), id },
						running: true,
						error: '',
						interrupted: false,
						reviewed: false,
					}
					entries.value.unshift(entry)
					// Keep Vue's reactive object for asynchronous updates.
					const live = entries.value[0]
					try {
						const response = await relayApi.runHybrid(
							JSON.parse(JSON.stringify(live.request)),
						)
						if (ticket === lifetime.generation) {
							if (response.ok) live.result = response.value
							else {
								live.error = response.error.message
								live.interrupted = [
									'OUTCOME_UNKNOWN',
									'INVALID_REQUEST',
									'BACKEND_UNAVAILABLE',
								].includes(response.error.code)
							}
						}
						return response
					} catch (error) {
						if (ticket === lifetime.generation) {
							live.error =
								'The result is unavailable. Recover it before sending again.'
							live.interrupted = true
						}
						throw error
					} finally {
						if (ticket === lifetime.generation) live.running = false
					}
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
		} catch {
			// Error is displayed beside the retained job.
		}
	}
	async function recover(entry: HybridEntry) {
		const ticket = lifetime.generation
		try {
			const result = await workspace.perform('Recover Hybrid Connection result', (id) =>
				relayApi.getHybridResult({
					id,
					profileId: entry.request.profileId,
					operationId: entry.id,
				}),
			)
			if (ticket !== lifetime.generation) return
			if (result) {
				entry.result = result
				entry.interrupted = false
				entry.error = ''
			} else
				entry.error =
					'No final result is available yet. The job may still be closing, or the backend was restarted. No operation was retried.'
		} catch {
			if (ticket === lifetime.generation)
				entry.error = 'Result recovery failed. Nothing was retried.'
		}
	}
	async function clear() {
		try {
			await workspace.perform('Stop Hybrid Connection jobs and clear history', (id) =>
				relayApi.resetHybrid({ id }),
			)
			reset()
		} catch {
			workspace.error = 'Hybrid Connection cleanup was not confirmed. Restart the backend.'
		}
	}
	return { run, recover, clear }
}
