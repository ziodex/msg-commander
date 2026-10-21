import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationTasks(
	state: Pick<RegistrationState, 'busy' | 'operationId' | 'error' | 'lifetime'>,
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
			const result = await workspace.perform(
				label,
				(id) => {
					operationId.value = id
					return action(id)
				},
				report,
			)
			if (ticket !== lifetime.generation) return
			apply?.(result)
			return result
		} catch (cause) {
			if (ticket === lifetime.generation)
				error.value = cause instanceof Error ? cause.message : 'Registration query failed.'
		} finally {
			if (ticket === lifetime.generation) busy.value = operationId.value = ''
		}
	}
	return { task }
}
