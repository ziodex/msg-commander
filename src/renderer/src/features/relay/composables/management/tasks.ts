import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
import type { RelayState } from '../../model/management-state'
export function createRelayTasks(
	state: Pick<RelayState, 'connection' | 'busy' | 'operationId' | 'error' | 'lifetime'>,
	workspace: ReturnType<typeof useWorkspace>,
) {
	const { connection, busy, operationId, error, lifetime } = state
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
				error.value = cause instanceof Error ? cause.message : 'Relay request failed.'
		} finally {
			if (ticket === lifetime.generation) {
				busy.value = operationId.value = ''
			}
		}
	}
	async function run<T>(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	) {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		return task(label, (id) => action(id, connectionId), apply, report)
	}
	return { task, run }
}
