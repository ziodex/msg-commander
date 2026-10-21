import type {
	NotificationOutcome,
	NotificationSenderConnection,
} from '@shared/contracts/notification-hubs/notifications'
import { computed, ref } from 'vue'
export function createSenderState() {
	const connection = ref<NotificationSenderConnection>(),
		busy = ref(''),
		operationId = ref(''),
		error = ref(''),
		outcome = ref<NotificationOutcome>(),
		reviewed = ref(false),
		composer = ref(false),
		inspection = ref(false)
	const lifetime = { generation: 0 }
	const blocked = computed(
		() => !!busy.value || (outcome.value?.status === 'unknown' && !reviewed.value),
	)

	return {
		connection,
		busy,
		operationId,
		error,
		outcome,
		reviewed,
		composer,
		inspection,
		blocked,
		lifetime,
	}
}
export type SenderState = ReturnType<typeof createSenderState>
