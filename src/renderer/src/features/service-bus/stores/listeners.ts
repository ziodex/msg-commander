import { updateListenerJob } from '../model/listener-job'
import { serviceBusApi } from '@/features/service-bus/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useServiceBus } from './service-bus'
import { useWorkspace } from '../../../shared/workspace/store'
import type { ListenerStart, ListenerState, ListenerSettle } from '@shared/listeners'
import type { DesktopResult } from '@shared/contracts'

export const useListeners = defineStore('listeners', () => {
	const sb = useServiceBus(),
		workspace = useWorkspace()
	const state = ref<ListenerState>()
	const busy = ref(false),
		error = ref(''),
		stale = ref(false)
	const active = computed(
		() => !!state.value && ['running', 'stopping'].includes(state.value.status),
	)
	let timer: ReturnType<typeof setTimeout> | undefined,
		generation = 0,
		polling = false
	function apply(value: ListenerState | null) {
		if (value) {
			const changed =
				state.value?.listenerId !== value.listenerId || state.value?.status !== value.status
			state.value = value
			if (changed || ['running', 'stopping'].includes(value.status))
				updateListenerJob(workspace, value)
		}
		stale.value = false
	}
	async function refresh() {
		if (!sb.connection || !workspace.ready || polling) return
		const connectionId = sb.connection.connectionId,
			ticket = generation
		polling = true
		try {
			const result = await serviceBusApi.getListener({
				id: crypto.randomUUID(),
				connectionId,
			})
			if (ticket !== generation) return
			if (result.ok) apply(result.value)
			else {
				stale.value = true
				error.value = result.error.message
			}
		} catch {
			if (ticket === generation) {
				stale.value = true
				error.value =
					'Listener status is unavailable. Check its state before repeating an action.'
			}
		} finally {
			polling = false
		}
	}
	async function poll(ticket: number) {
		await refresh()
		if (ticket === generation && sb.connection && workspace.ready)
			timer = setTimeout(() => void poll(ticket), active.value ? 500 : 1500)
	}
	watch(
		() => [sb.connection?.connectionId, workspace.ready] as const,
		() => {
			generation++
			clearTimeout(timer)
			if (state.value && active.value) {
				updateListenerJob(workspace, {
					...state.value,
					status: 'unknown',
					summary:
						'Connection closed. Final counts may be incomplete; inspect the source before resuming.',
				})
			}
			state.value = undefined
			error.value = ''
			busy.value = false
			stale.value = false
			if (sb.connection && workspace.ready) void poll(generation)
		},
		{ immediate: true },
	)
	async function command(
		action: (connectionId: string) => Promise<DesktopResult<ListenerState>>,
	) {
		if (!sb.connection || busy.value) return false
		const ticket = generation,
			connectionId = sb.connection.connectionId
		busy.value = true
		error.value = ''
		try {
			const result = await action(connectionId)
			if (ticket !== generation) return false
			if (!result.ok) {
				error.value = result.error.message
				stale.value = true
				return false
			}
			apply(result.value)
			return true
		} catch {
			if (ticket === generation) {
				error.value =
					'The listener request was interrupted. Refresh its status; it will not be retried automatically.'
				stale.value = true
			}
			return false
		} finally {
			if (ticket === generation) {
				busy.value = false
				await refresh()
			}
		}
	}
	async function start(input: Omit<ListenerStart, 'id' | 'connectionId'>) {
		return command((connectionId) =>
			serviceBusApi.startListener({
				...input,
				target: { ...input.target },
				id: crypto.randomUUID(),
				connectionId,
			}),
		)
	}
	async function stop() {
		const listenerId = state.value?.listenerId
		if (listenerId)
			await command((connectionId) =>
				serviceBusApi.stopListener({ id: crypto.randomUUID(), connectionId, listenerId }),
			)
	}
	async function settle(
		input: Pick<ListenerSettle, 'deliveryId' | 'action' | 'reason' | 'description'>,
	) {
		const listenerId = state.value?.listenerId
		if (listenerId)
			return command((connectionId) =>
				serviceBusApi.settleListener({
					...input,
					id: crypto.randomUUID(),
					connectionId,
					listenerId,
				}),
			)
		return false
	}
	return { state, busy, error, stale, active, refresh, start, stop, settle }
})
