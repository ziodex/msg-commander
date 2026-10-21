import { eventHubsJob } from '@/features/event-hubs/operation-progress'
import { type EventTab } from '@/features/event-hubs/lib/event-tabs'
import type { EventHubSendResult } from '@shared/contracts/event-hubs/sending'
import { computed, ref } from 'vue'
import { useWorkspace } from '@/shared/workspace/store'

import type {
	EventHubStatistics,
	EventHubsConnection,
	EventHubsPage,
	EventHubInfo,
	EventHubPartition,
	EventHubReadResult,
	EventDetails,
} from '@shared/contracts/event-hubs/core'

export function createEventHubsState(workspace: ReturnType<typeof useWorkspace>) {
	const connection = ref<EventHubsConnection>(),
		hubs = ref<EventHubsPage>({ items: [], continuationToken: null }),
		groups = ref<EventHubsPage>({ items: [], continuationToken: null })
	const hubName = ref(''),
		hub = ref<EventHubInfo>(),
		partition = ref<EventHubPartition>(),
		partitionId = ref(''),
		consumerGroup = ref('$Default')
	const busy = ref(''),
		error = ref(''),
		operationId = ref(''),
		readId = ref(''),
		result = ref<EventHubReadResult>(),
		interrupted = ref(false)
	const event = ref<EventDetails>(),
		body = ref<Uint8Array>(new Uint8Array()),
		bodyOffset = ref(0),
		nextOffset = ref<number | null>(null)
	const sendId = ref(''),
		sendResult = ref<EventHubSendResult>(),
		sendInterrupted = ref(false)
	const sendJob = computed(() =>
		eventHubsJob(workspace.jobs.find((job) => job.id === sendId.value)),
	)
	const sending = computed(() => sendJob.value?.status === 'running')
	const statistics = ref<EventHubStatistics>(),
		urlNotice = ref('')
	const lifetime = { generation: 0 }
	const readJob = computed(() =>
		eventHubsJob(workspace.jobs.find((job) => job.id === readId.value)),
	)
	const reading = computed(() => readJob.value?.status === 'running')
	const tabs = ref<EventTab[]>([]),
		activeTabId = ref('')
	const serviceName = computed(() =>
		connection.value?.service === 'iot-hub' ? 'IoT Hub' : 'Event Hubs',
	)
	return {
		connection,
		hubs,
		groups,
		hubName,
		hub,
		partition,
		partitionId,
		consumerGroup,
		busy,
		error,
		operationId,
		readId,
		result,
		interrupted,
		event,
		body,
		bodyOffset,
		nextOffset,
		sendId,
		sendResult,
		sendInterrupted,
		sendJob,
		sending,
		statistics,
		urlNotice,
		readJob,
		reading,
		tabs,
		activeTabId,
		serviceName,
		lifetime,
	}
}
export type EventHubsState = ReturnType<typeof createEventHubsState>
