import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'

import type { EventGridState } from '../model/state'

export function createEventGridTasks(
	state: Pick<EventGridState, 'busy' | 'operationId' | 'error' | 'lifetime'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const { busy, operationId, error, lifetime } = state

	async function task<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	) {
		if (busy.value) return
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
			if (ticket !== lifetime.generation) return
			apply?.(value)
			return value
		} catch (cause) {
			if (ticket === lifetime.generation)
				error.value = cause instanceof Error ? cause.message : 'Event Grid read failed.'
		} finally {
			if (ticket === lifetime.generation) busy.value = operationId.value = ''
		}
	}
	return { task }
}
