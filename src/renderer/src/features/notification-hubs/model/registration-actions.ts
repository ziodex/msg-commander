import type {
	NotificationHubRegistrationQuery,
	NotificationHubRegistrationsPage,
} from '@shared/contracts/notification-hubs/registrations'
import type { NotificationTaskActions } from './task-actions'
export interface RegistrationActions extends NotificationTaskActions {
	search(
		selected: NotificationHubRegistrationQuery,
	): Promise<NotificationHubRegistrationsPage | undefined>
	reset(): void
}
