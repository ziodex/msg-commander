import type {
	NotificationHubJob,
	NotificationHubJobOutcome,
	NotificationHubJobReview,
	NotificationHubJobsPage,
} from '@shared/contracts/notification-hubs/jobs'
import type {
	RegistrationFileDetails,
	RegistrationFilePreview,
	RegistrationFileResult,
} from '@shared/contracts/notification-hubs/registration-files'
import {
	defaultRegistrationQuery,
	type NotificationHubRegistrationDetails,
	type NotificationHubRegistrationOutcome,
	type NotificationHubRegistrationQuery,
	type NotificationHubRegistrationsConnection,
	type NotificationHubRegistrationsPage,
} from '@shared/contracts/notification-hubs/registrations'
import { computed, ref } from 'vue'
export function createRegistrationState() {
	const connection = ref<NotificationHubRegistrationsConnection>(),
		busy = ref(''),
		operationId = ref(''),
		error = ref('')
	const page = ref<NotificationHubRegistrationsPage>(),
		details = ref<NotificationHubRegistrationDetails>(),
		query = ref<NotificationHubRegistrationQuery>(defaultRegistrationQuery())
	const editor = ref<{
		action: 'create' | 'update' | 'delete'
		details?: NotificationHubRegistrationDetails
	}>()
	const outcome = ref<NotificationHubRegistrationOutcome>(),
		reviewed = ref(false)
	const filePreview = ref<RegistrationFilePreview>(),
		fileName = ref(''),
		fileDetails = ref<RegistrationFileDetails>(),
		fileOutcome = ref<RegistrationFileResult>(),
		fileReviewed = ref(false)
	const jobReview = ref<NotificationHubJobReview>(),
		jobOutcome = ref<NotificationHubJobOutcome>(),
		jobPage = ref<NotificationHubJobsPage>(),
		selectedJob = ref<NotificationHubJob>(),
		jobReviewed = ref(false)
	const blocked = computed(
		() =>
			!!busy.value ||
			(outcome.value?.status === 'unknown' && !reviewed.value) ||
			(fileOutcome.value?.status === 'unknown' && !fileReviewed.value) ||
			(jobOutcome.value?.status === 'unknown' && !jobReviewed.value),
	)
	const pageNumber = ref(0)
	const lifetime = { generation: 0, cursors: [] as (string | null)[] }

	return {
		connection,
		busy,
		operationId,
		error,
		page,
		details,
		query,
		editor,
		outcome,
		reviewed,
		filePreview,
		fileName,
		fileDetails,
		fileOutcome,
		fileReviewed,
		jobReview,
		jobOutcome,
		jobPage,
		selectedJob,
		jobReviewed,
		blocked,
		pageNumber,
		lifetime,
	}
}
export type RegistrationState = ReturnType<typeof createRegistrationState>
