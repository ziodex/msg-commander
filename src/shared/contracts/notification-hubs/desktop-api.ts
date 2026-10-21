import {
	type CredentialGet,
	type CredentialStatus,
	type CredentialImport,
	type CredentialImportResult,
	type CredentialDiscard,
	type CredentialChange,
} from './credentials'
import { type DesktopResult } from '../platform/desktop'
import {
	type NotificationHubOutcome,
	type NotificationHubRequest,
	type NotificationHubResult,
	type NotificationHubConnect,
	type NotificationHubConnection,
	type NotificationHubList,
	type NotificationHubPage,
	type NotificationHubGet,
	type NotificationHubDetails,
	type NotificationHubChange,
	type NotificationHubKey,
	type NotificationHubCopyKey,
} from './core'
import {
	type NotificationHubRegistrationInspect,
	type NotificationHubRegistrationDetails,
	type NotificationHubRegistrationChange,
	type NotificationHubRegistrationOutcome,
	type NotificationHubRegistrationResult,
	type NotificationHubRegistrationsConnect,
	type NotificationHubRegistrationsConnection,
	type NotificationHubRegistrationsRequest,
	type NotificationHubRegistrationsQuery,
	type NotificationHubRegistrationsPage,
} from './registrations'
import {
	type NotificationSenderConnect,
	type NotificationSenderConnection,
	type NotificationSenderRequest,
	type NotificationSend,
	type NotificationOutcome,
	type NotificationSenderResult,
} from './notifications'
import {
	type NotificationHubJobsPage,
	type NotificationHubJobGet,
	type NotificationHubJob,
	type NotificationHubJobPreview,
	type NotificationHubJobReview,
	type NotificationHubJobSubmit,
	type NotificationHubJobOutcome,
} from './jobs'
import {
	type RegistrationFileExport,
	type RegistrationFileImportResult,
	type RegistrationFileInspect,
	type RegistrationFileDetails,
	type RegistrationFileApply,
	type RegistrationFileResult,
} from './registration-files'
import { type FileResult } from '../../message-files'
import {
	type NotificationHubConfigExport,
	type NotificationHubConfigImportResult,
	type NotificationHubConfigApply,
	type NotificationHubConfigResult,
} from './configuration'
import { type AuthorizationKey } from '../../authorization'

export interface NotificationHubsDesktopApi {
	getNotificationHubCredentials(request: CredentialGet): Promise<DesktopResult<CredentialStatus>>
	importNotificationHubCredential(
		request: CredentialImport,
	): Promise<DesktopResult<CredentialImportResult>>
	discardNotificationHubCredential(request: CredentialDiscard): Promise<DesktopResult<null>>
	changeNotificationHubCredentials(
		request: CredentialChange,
	): Promise<DesktopResult<NotificationHubOutcome>>
	getNotificationHubRegistration(
		request: NotificationHubRegistrationInspect,
	): Promise<DesktopResult<NotificationHubRegistrationDetails>>
	changeNotificationHubRegistration(
		request: NotificationHubRegistrationChange,
	): Promise<DesktopResult<NotificationHubRegistrationOutcome>>
	getNotificationHubRegistrationResult(
		request: NotificationHubRegistrationResult,
	): Promise<DesktopResult<NotificationHubRegistrationOutcome | null>>
	connectNotificationSender(
		request: NotificationSenderConnect,
	): Promise<DesktopResult<NotificationSenderConnection>>
	disconnectNotificationSender(request: NotificationSenderRequest): Promise<DesktopResult<null>>
	sendTestNotification(request: NotificationSend): Promise<DesktopResult<NotificationOutcome>>
	getTestNotificationResult(
		request: NotificationSenderResult,
	): Promise<DesktopResult<NotificationOutcome | null>>
	connectNotificationHubRegistrations(
		request: NotificationHubRegistrationsConnect,
	): Promise<DesktopResult<NotificationHubRegistrationsConnection>>
	listNotificationHubJobs(
		request: NotificationHubRegistrationsRequest,
	): Promise<DesktopResult<NotificationHubJobsPage>>
	getNotificationHubJob(
		request: NotificationHubJobGet,
	): Promise<DesktopResult<NotificationHubJob>>
	previewNotificationHubJob(
		request: NotificationHubJobPreview,
	): Promise<DesktopResult<NotificationHubJobReview>>
	discardNotificationHubJob(
		request: NotificationHubRegistrationsRequest,
	): Promise<DesktopResult<null>>
	submitNotificationHubJob(
		request: NotificationHubJobSubmit,
	): Promise<DesktopResult<NotificationHubJobOutcome>>
	getNotificationHubJobResult(
		request: NotificationHubRegistrationResult,
	): Promise<DesktopResult<NotificationHubJobOutcome | null>>
	disconnectNotificationHubRegistrations(
		request: NotificationHubRegistrationsRequest,
	): Promise<DesktopResult<null>>
	queryNotificationHubRegistrations(
		request: NotificationHubRegistrationsQuery,
	): Promise<DesktopResult<NotificationHubRegistrationsPage>>
	inspectNotificationHubRegistration(
		request: NotificationHubRegistrationInspect,
	): Promise<DesktopResult<NotificationHubRegistrationDetails>>
	exportNotificationHubRegistrations(
		request: RegistrationFileExport,
	): Promise<DesktopResult<FileResult>>
	importNotificationHubRegistrations(
		request: NotificationHubRegistrationsRequest,
	): Promise<DesktopResult<RegistrationFileImportResult>>
	inspectNotificationHubRegistrationImport(
		request: RegistrationFileInspect,
	): Promise<DesktopResult<RegistrationFileDetails>>
	applyNotificationHubRegistrationImport(
		request: RegistrationFileApply,
	): Promise<DesktopResult<RegistrationFileResult>>
	getNotificationHubRegistrationImportResult(
		request: NotificationHubRegistrationResult,
	): Promise<DesktopResult<RegistrationFileResult | null>>
	exportNotificationHubConfiguration(
		request: NotificationHubConfigExport,
	): Promise<DesktopResult<FileResult & { warnings?: string[] }>>
	importNotificationHubConfiguration(
		request: NotificationHubRequest,
	): Promise<DesktopResult<NotificationHubConfigImportResult>>
	applyNotificationHubConfiguration(
		request: NotificationHubConfigApply,
	): Promise<DesktopResult<NotificationHubConfigResult>>
	getNotificationHubConfigurationResult(
		request: NotificationHubResult,
	): Promise<DesktopResult<NotificationHubConfigResult | null>>
	connectNotificationHub(
		request: NotificationHubConnect,
	): Promise<DesktopResult<NotificationHubConnection>>
	disconnectNotificationHub(request: NotificationHubRequest): Promise<DesktopResult<null>>
	listNotificationHub(request: NotificationHubList): Promise<DesktopResult<NotificationHubPage>>
	getNotificationHubResource(
		request: NotificationHubGet,
	): Promise<DesktopResult<NotificationHubDetails>>
	changeNotificationHubResource(
		request: NotificationHubChange,
	): Promise<DesktopResult<NotificationHubOutcome>>
	getNotificationHubResult(
		request: NotificationHubResult,
	): Promise<DesktopResult<NotificationHubOutcome | null>>
	revealNotificationHubKey(request: NotificationHubKey): Promise<DesktopResult<AuthorizationKey>>
	copyNotificationHubKey(request: NotificationHubCopyKey): Promise<DesktopResult<null>>
}
