import type { ServiceBusState } from '../model/state'

export function createServiceBusTasks(
	state: Pick<ServiceBusState, 'busy' | 'error' | 'generation' | 'workspace'>,
) {
	const { busy, error, generation, workspace } = state
	async function task<T>(
		label: string,
		action: Parameters<typeof workspace.perform<T>>[1],
		apply: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<boolean> {
		if (busy.value) return false
		const ticket = generation.current
		busy.value = label
		error.value = ''
		try {
			const result = await workspace.perform(label, action, report)
			if (ticket !== generation.current) return false
			apply(result)
			return true
		} catch (cause) {
			if (ticket === generation.current)
				error.value = cause instanceof Error ? cause.message : 'The request failed.'
			return false
		} finally {
			if (ticket === generation.current) busy.value = ''
		}
	}
	return { task }
}
