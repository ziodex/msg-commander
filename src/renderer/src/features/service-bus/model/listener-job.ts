import type { ListenerState } from '@shared/listeners'
import type { useWorkspace } from '@/shared/workspace/store'
import { serviceBusApi } from '../api'

export function updateListenerJob(
	workspace: ReturnType<typeof useWorkspace>,
	state: ListenerState,
) {
	workspace.recordJob({
		id: state.listenerId,
		startedAt:
			workspace.jobs.find((job) => job.id === state.listenerId)?.startedAt ??
			new Date().toISOString(),
		label: `Listener: ${state.target.kind === 'subscription' ? state.target.topicName + '/' : ''}${state.target.name}`,
		status: ['running', 'stopping'].includes(state.status)
			? 'running'
			: ['failed', 'unknown'].includes(state.status)
				? 'failed'
				: state.status === 'stopped'
					? 'cancelled'
					: 'completed',
		percent: undefined,
		message: `${state.sessionMode === 'next-available' ? `${state.activeSessions}/${state.maxConcurrentSessions} sessions owned · ` : ''}${state.received} received · ${state.completed} completed · ${state.failed} failed · ${state.uncertain} uncertain. ${state.summary}`,
		cancel: async () => {
			const result = workspace.unwrapResult(
				await serviceBusApi.stopListener({
					id: crypto.randomUUID(),
					connectionId: state.connectionId,
					listenerId: state.listenerId,
				}),
			)
			updateListenerJob(workspace, result)
		},
	})
}
