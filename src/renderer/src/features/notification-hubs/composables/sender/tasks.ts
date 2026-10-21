import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
import type { SenderState } from '../../model/sender-state'
export function createSenderTasks(
	state: Pick<SenderState, 'busy' | 'operationId' | 'error' | 'lifetime'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const { busy, operationId, error, lifetime } = state
	async function task<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: (value: T) => { status: 'completed' | 'failed' | 'cancelled'; message: string },
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
				error.value =
					cause instanceof Error ? cause.message : 'Notification operation failed.'
		} finally {
			if (ticket === lifetime.generation) busy.value = operationId.value = ''
		}
	}
	return { task }
}
