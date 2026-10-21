import type {
	EventGridReceived,
	EventGridEventInspection,
	EventGridPullOutcome,
} from '@shared/contracts/event-grid/pulling'
import type { EventGridPublishOutcome } from '@shared/contracts/event-grid/publishing'
import type { EventGridAdminOutcome } from '@shared/contracts/event-grid/administration'
import { computed, ref } from 'vue'

import {
	type EventGridConnection,
	type EventGridTarget,
	type EventGridPage,
	type EventGridDetails,
} from '@shared/contracts/event-grid/core'

export function createEventGridState() {
	const connection = ref<EventGridConnection>(),
		topics = ref<EventGridPage>(),
		subscriptions = ref<Record<string, EventGridPage>>({}),
		expanded = ref<string[]>([]),
		details = ref<EventGridDetails>(),
		inspection = ref<EventGridTarget>(),
		busy = ref(''),
		operationId = ref(''),
		error = ref(''),
		outcome = ref<EventGridAdminOutcome>(),
		reviewed = ref(false),
		publishOutcome = ref<EventGridPublishOutcome>(),
		publishReviewed = ref(false)
	const received = ref<Record<string, EventGridReceived[]>>({}),
		eventInspection = ref<EventGridEventInspection>(),
		pullOutcome = ref<EventGridPullOutcome>(),
		pullReviewed = ref(false)
	const lifetime = { generation: 0 }
	const blocked = computed(() => !!busy.value)
	const writeBlocked = computed(
		() =>
			blocked.value ||
			(pullOutcome.value?.status === 'unknown' && !pullReviewed.value) ||
			(publishOutcome.value?.status === 'unknown' && !publishReviewed.value) ||
			(!!outcome.value &&
				['unknown', 'accepted'].includes(outcome.value.status) &&
				!reviewed.value),
	)
	return {
		connection,
		topics,
		subscriptions,
		expanded,
		details,
		inspection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		publishOutcome,
		publishReviewed,
		received,
		eventInspection,
		pullOutcome,
		pullReviewed,
		lifetime,
		blocked,
		writeBlocked,
	}
}
export type EventGridState = ReturnType<typeof createEventGridState>
