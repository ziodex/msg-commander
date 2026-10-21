import { notificationHubsApi } from '@/features/notification-hubs/api'
import { type NotificationHubRegistrationQuery } from '@shared/contracts/notification-hubs/registrations'
import type { RegistrationActions } from '../../model/registration-actions'
import type { RegistrationState } from '../../model/registrations-state'
export function createRegistrationBrowsing(
	state: Pick<
		RegistrationState,
		'connection' | 'page' | 'details' | 'query' | 'pageNumber' | 'lifetime'
	>,
	actions: Pick<RegistrationActions, 'task'>,
) {
	const { connection, page, details, query, pageNumber, lifetime } = state
	const { task } = actions
	async function fetchPage(
		selected: NotificationHubRegistrationQuery,
		index: number,
		cursor: string | null,
	) {
		if (!connection.value) return
		return task(
			'Query Notification Hubs registrations',
			(id) =>
				notificationHubsApi.queryNotificationHubRegistrations({
					id,
					connectionId: connection.value!.connectionId,
					query: { ...selected },
					continuationToken: cursor,
				}),
			(result) => {
				if (index === 0) lifetime.cursors = [null]
				lifetime.cursors[index] = cursor
				lifetime.cursors.length = index + 1
				page.value = result
				pageNumber.value = index + 1
				query.value = { ...selected }
				details.value = undefined
			},
		)
	}
	const search = (selected: NotificationHubRegistrationQuery) => fetchPage(selected, 0, null)
	const next = () =>
		page.value?.continuationToken &&
		fetchPage(query.value, pageNumber.value, page.value.continuationToken)
	const previous = () =>
		pageNumber.value > 1 &&
		fetchPage(query.value, pageNumber.value - 2, lifetime.cursors[pageNumber.value - 2])
	async function inspect(snapshotId: string) {
		if (!connection.value) return
		await task(
			'Inspect Notification Hubs registration',
			(id) =>
				notificationHubsApi.inspectNotificationHubRegistration({
					id,
					connectionId: connection.value!.connectionId,
					snapshotId,
				}),
			(value) => {
				details.value = value
			},
		)
	}
	async function refreshInspection() {
		if (!details.value || !connection.value) return
		const snapshotId = details.value.registration.snapshotId
		await task(
			'Reload registration inspection',
			(id) =>
				notificationHubsApi.getNotificationHubRegistration({
					id,
					connectionId: connection.value!.connectionId,
					snapshotId,
				}),
			(value) => {
				details.value = value
			},
		)
	}
	return { fetchPage, search, next, previous, inspect, refreshInspection }
}
