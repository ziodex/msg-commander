import type {
	NotificationHubConfigPreview,
	NotificationHubConfigResult,
} from '@shared/contracts/notification-hubs/configuration'

import { computed, ref } from 'vue'

import {
	nhNamespace,
	type NotificationHubConnection,
	type NotificationHubPage,
	type NotificationHubDetails,
	type NotificationHubScope,
	type NotificationHubOutcome,
} from '@shared/contracts/notification-hubs/core'

export function createNotificationManagementState() {
	const connection = ref<NotificationHubConnection>(),
		busy = ref(''),
		operationId = ref(''),
		error = ref('')
	const hubs = ref<NotificationHubPage>({ items: [], continuationToken: null })
	const selected = ref<NotificationHubScope>({ ...nhNamespace }),
		details = ref<NotificationHubDetails>(),
		policies = ref<NotificationHubPage>({ items: [], continuationToken: null })
	const outcome = ref<NotificationHubOutcome>(),
		reviewed = ref(false)
	const configPreview = ref<NotificationHubConfigPreview>(),
		configFileName = ref(''),
		configOutcome = ref<NotificationHubConfigResult>(),
		configReviewed = ref(false)
	const blocked = computed(
		() =>
			!!busy.value ||
			(outcome.value?.status === 'unknown' && !reviewed.value) ||
			(configOutcome.value?.status === 'unknown' && !configReviewed.value),
	)
	const lifetime = { generation: 0 }
	return {
		connection,
		busy,
		operationId,
		error,
		hubs,
		selected,
		details,
		policies,
		outcome,
		reviewed,
		configPreview,
		configFileName,
		configOutcome,
		configReviewed,
		blocked,
		lifetime,
	}
}
export type NotificationManagementState = ReturnType<typeof createNotificationManagementState>
