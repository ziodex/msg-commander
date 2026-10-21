import { useWorkspace } from '@/shared/workspace/store'

import type { EventHubsState } from '../model/state'

export function createEventHubsTasks(
	state: Pick<EventHubsState, 'busy' | 'error' | 'operationId' | 'lifetime'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const { busy, error, operationId, lifetime } = state

	async function task<T>(
		label: string,
		action: Parameters<typeof workspace.perform<T>>[1],
		apply: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	) {
		if (busy.value) return false
		const ticket = lifetime.generation
		busy.value = label
		error.value = ''
		try {
			const value = await workspace.perform(
				label,
				(id) => {
					operationId.value = id
					return action(id)
				},
				report,
			)
			if (ticket !== lifetime.generation) return false
			apply(value)
			return true
		} catch (cause) {
			if (ticket === lifetime.generation)
				error.value = cause instanceof Error ? cause.message : 'Event Hubs request failed.'
			return false
		} finally {
			if (ticket === lifetime.generation) {
				busy.value = ''
				operationId.value = ''
			}
		}
	}
	return { task }
}
