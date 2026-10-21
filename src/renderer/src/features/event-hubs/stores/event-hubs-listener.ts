import { eventHubsJob } from '@/features/event-hubs/operation-progress'
import { eventHubsApi } from '@/features/event-hubs/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useEventHubs } from './event-hubs'
import { useWorkspace } from '../../../shared/workspace/store'
import type {
	EventListen,
	EventListenResult,
	EventCheckpoint,
} from '@shared/contracts/event-hubs/listening'
import type { DesktopResult } from '@shared/contracts'
export const useEventListener = defineStore('event-hubs-listener', () => {
	const eh = useEventHubs(),
		workspace = useWorkspace(),
		operationId = ref(''),
		target = ref<Omit<EventListen, 'id' | 'connectionId'>>(),
		result = ref<EventListenResult>(),
		interrupted = ref(false),
		checkpoint = ref<EventCheckpoint>(),
		notice = ref('')
	const job = computed(() =>
			eventHubsJob(workspace.jobs.find((j) => j.id === operationId.value)),
		),
		running = computed(() => job.value?.status === 'running'),
		progress = computed(() => job.value?.eventHubListen)
	let generation = 0
	watch(
		() => eh.connection?.connectionId,
		() => {
			generation++
			target.value = undefined
			operationId.value = ''
			result.value = undefined
			interrupted.value = false
			checkpoint.value = undefined
			notice.value = ''
		},
		{ flush: 'sync' },
	)
	async function task<T>(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
	) {
		if (!eh.connection || eh.busy) return
		const connectionId = eh.connection.connectionId
		let value: T | undefined
		await eh.task(
			label,
			(id) => action(id, connectionId),
			(v) => {
				value = v
			},
		)
		return value
	}
	async function listen(setup: Omit<EventListen, 'id' | 'connectionId'>) {
		if (!eh.connection || eh.busy || interrupted.value || result.value?.cleanupWarning) return
		const ticket = generation,
			connectionId = eh.connection.connectionId
		target.value = JSON.parse(JSON.stringify(setup))
		result.value = undefined
		operationId.value = ''
		notice.value = ''
		eh.clearEvent()
		eh.result = undefined
		eh.readId = ''
		await eh.task(
			`Listen to all ${eh.serviceName === 'IoT Hub' ? 'IoT Hub' : 'Event Hub'} partitions`,
			async (id) => {
				operationId.value = id
				try {
					const response = await eventHubsApi.listenEventHub({
						...setup,
						id,
						connectionId,
					})
					if (
						ticket === generation &&
						!response.ok &&
						['TIMEOUT', 'BACKEND_UNAVAILABLE', 'INVALID_REQUEST', 'CANCELLED'].includes(
							response.error.code,
						)
					)
						interrupted.value = true
					return response
				} catch (e) {
					if (ticket === generation) interrupted.value = true
					throw e
				}
			},
			(value) => {
				result.value = value
			},
			(value) => ({
				status:
					value.status === 'failed'
						? 'failed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'completed',
				message: value.summary,
			}),
		)
	}
	async function recover() {
		if (!operationId.value) return
		const id = operationId.value
		const value = await task('Recover Event Hubs listener result', (operation, connectionId) =>
			eventHubsApi.getEventListenerResult({ id: operation, connectionId, operationId: id }),
		)
		if (value) {
			result.value = value
			interrupted.value = false
		} else if (value === null)
			eh.error =
				'No retained result is available. No checkpoint was saved automatically; reconnect and load your last saved checkpoint to read again.'
	}
	async function loadCheckpoint(hubName: string, consumerGroup: string) {
		const value = await task('Load Event Hubs checkpoint', (id, connectionId) =>
			eventHubsApi.loadEventCheckpoint({ id, connectionId, hubName, consumerGroup }),
		)
		if (value && !value.cancelled && value.checkpoint) {
			checkpoint.value = value.checkpoint
			notice.value = `Loaded ${value.fileName}. Azure scope, partition changes and retention will be checked before listening.`
			return true
		}
		return false
	}
	async function saveCheckpoint() {
		if (!result.value?.checkpoint) return
		const value = await task('Save Event Hubs checkpoint', (id, connectionId) =>
			eventHubsApi.saveEventCheckpoint({
				id,
				connectionId,
				operationId: result.value!.operationId,
			}),
		)
		if (value && !value.cancelled)
			notice.value = `Saved ${value.fileName}. This checkpoint records the next unread position in each partition.`
	}
	async function exportEvents(snapshotIds: string[], format: 'archive' | 'body' = 'archive') {
		const value = await task('Export Event Hubs events', (id, connectionId) =>
			eventHubsApi.exportEvents({ id, connectionId, snapshotIds, format }),
		)
		if (value && !value.cancelled)
			notice.value = `Saved ${value.count} event${value.count === 1 ? '' : 's'} to ${value.fileName}.`
	}
	return {
		target,
		operationId,
		result,
		interrupted,
		checkpoint,
		notice,
		job,
		running,
		progress,
		task,
		listen,
		recover,
		loadCheckpoint,
		saveCheckpoint,
		exportEvents,
	}
})
