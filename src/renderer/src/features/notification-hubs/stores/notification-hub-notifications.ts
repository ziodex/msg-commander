import { useWorkspace } from '@/shared/workspace/store'
import { defineStore } from 'pinia'
import { createSenderLifecycle } from '../composables/sender/lifecycle'
import { createSenderSending } from '../composables/sender/sending'
import { createSenderTasks } from '../composables/sender/tasks'
import { createSenderState } from '../model/sender-state'
export const useNotificationSender = defineStore('notification-sender', () => {
	const workspace = useWorkspace(),
		state = createSenderState()
	const {
		connection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		composer,
		inspection,
		blocked,
	} = state
	const tasks = createSenderTasks(state, workspace)
	const { task } = tasks
	const lifecycle = createSenderLifecycle(state, { task }, workspace)
	const { reset, connect, disconnect, cancel } = lifecycle
	const sending = createSenderSending(state, { task })
	const { send, recover } = sending
	return {
		connection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		blocked,
		composer,
		inspection,
		reset,
		task,
		connect,
		disconnect,
		send,
		recover,
		cancel,
	}
})
