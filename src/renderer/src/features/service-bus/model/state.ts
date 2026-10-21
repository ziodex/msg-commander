import { type EntityTab } from '@/features/service-bus/lib/entity-tabs'

import type { BulkPurgePlan, BulkPurgeResult } from '@shared/contracts/service-bus/maintenance'
import { type MessageSubQueue } from '@shared/service-bus'
import type { PurgeResult } from '@shared/contracts/service-bus/maintenance'
import type { ResendResult } from '@shared/contracts/service-bus/maintenance'

import { computed, ref, shallowRef } from 'vue'
import type {
	Entity,
	EntityDetails,
	EntityPage,
	MessageDetails,
	NamespaceConnection,
	PeekPage,
} from '@shared/service-bus'

import { useWorkspace } from '@/shared/workspace/store'

import type { Deliveries, OperationOutcome } from '@shared/message-operations'

export function createServiceBusState(workspace: ReturnType<typeof useWorkspace>) {
	const connection = ref<NamespaceConnection>()
	const category = ref<'queue' | 'topic' | 'subscription'>('queue')
	const topicName = ref<string>()
	const entities = ref<EntityPage>({ items: [], continuationToken: null })
	const currentToken = ref<string | null>(null)
	const history = ref<(string | null)[]>([])
	const selected = ref<Entity>()
	const selectionView = ref<'entity' | 'messages'>('entity')
	const details = ref<EntityDetails>()
	const messages = ref<PeekPage>()
	const message = ref<MessageDetails>()
	const body = shallowRef(new Uint8Array())
	const bodyStart = ref(0)
	const nextBodyOffset = ref<number | null>(null)
	const subQueue = ref<MessageSubQueue>('active')
	const fromSequence = ref('0')
	const pageSize = ref(workspace.preferences.peekCount)
	const busy = ref('')
	const error = ref('')
	const filter = ref('')
	const peekedFrom = ref('0')
	const held = ref<Deliveries>({
		target: null,
		subQueue: 'active',
		sessionId: null,
		items: [],
		warning: null,
	})
	const outcome = ref<OperationOutcome>()
	const purgeResult = ref<PurgeResult>()
	const purgeOperationId = ref('')
	const purgeInterrupted = ref(false)
	const bulkPurgePlan = ref<BulkPurgePlan>()
	const bulkPurgeResult = ref<BulkPurgeResult>()
	const bulkPurgeOperationId = ref('')
	const bulkPurgeInterrupted = ref(false)
	const bulkPurgeNeedsReview = ref(false)
	const resendResult = ref<ResendResult>()
	const resendOperationId = ref('')
	const resendInterrupted = ref(false)
	const generation = { current: 0 }
	const visibleEntities = computed(() =>
		entities.value.items.filter((item) =>
			item.target.name.toLowerCase().includes(filter.value.toLowerCase()),
		),
	)
	const tabs = ref<EntityTab[]>([])
	const activeTabId = ref('')
	const fileNotice = ref('')
	return {
		workspace,
		connection,
		category,
		topicName,
		entities,
		currentToken,
		history,
		selected,
		selectionView,
		details,
		messages,
		message,
		body,
		bodyStart,
		nextBodyOffset,
		subQueue,
		fromSequence,
		pageSize,
		busy,
		error,
		filter,
		peekedFrom,
		held,
		outcome,
		purgeResult,
		purgeOperationId,
		purgeInterrupted,
		bulkPurgePlan,
		bulkPurgeResult,
		bulkPurgeOperationId,
		bulkPurgeInterrupted,
		bulkPurgeNeedsReview,
		resendResult,
		resendOperationId,
		resendInterrupted,
		generation,
		visibleEntities,
		tabs,
		activeTabId,
		fileNotice,
	}
}
export type ServiceBusState = ReturnType<typeof createServiceBusState>
