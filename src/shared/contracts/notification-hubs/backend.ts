import {
	type NotificationSenderConnect,
	type NotificationSenderRequest,
	type NotificationSend,
	type NotificationSenderResult,
	nhNotificationsConnectionSchema,
	notificationOutcomeSchema,
} from './notifications'
import { type ProfileInput } from '../platform/profiles'
import {
	type NotificationHubRegistrationInspect,
	type NotificationHubRegistrationChange,
	type NotificationHubRegistrationResult,
	type NotificationHubRegistrationsConnect,
	type NotificationHubRegistrationsRequest,
	type NotificationHubRegistrationsQuery,
	nhRegistrationDetailsSchema,
	nhRegistrationOutcomeSchema,
	nhRegistrationsConnectionSchema,
	nhRegistrationsPageSchema,
} from './registrations'
import {
	type NotificationHubJobGet,
	type NotificationHubJobPreview,
	type NotificationHubJobSubmit,
	nhJobsPageSchema,
	nhJobSchema,
	nhJobReviewSchema,
	nhJobOutcomeSchema,
} from './jobs'
import {
	type RegistrationFileExport,
	type RegistrationFileInspect,
	type RegistrationFileApply,
	registrationFileEncodedSchema,
	registrationFilePreviewSchema,
	registrationFileDetailsSchema,
	registrationFileResultSchema,
} from './registration-files'
import {
	type NotificationHubConfigExport,
	type NotificationHubConfigApply,
	nhConfigEncodedSchema,
	nhConfigPreviewSchema,
	nhConfigResultSchema,
} from './configuration'
import {
	type NotificationHubRequest,
	type NotificationHubResult,
	type NotificationHubManagement,
	type NotificationHubList,
	type NotificationHubGet,
	type NotificationHubChange,
	type NotificationHubKey,
	nhConnectionSchema,
	nhPageSchema,
	nhDetailsSchema,
	nhOutcomeSchema,
	nhKeyResultSchema,
} from './core'
import {
	type CredentialGet,
	type CredentialImport,
	type CredentialDiscard,
	type CredentialChange,
	credentialStatusSchema,
	credentialArtifactSchema,
} from './credentials'
import { z } from 'zod'

export type NotificationHubsBackendParams = {
	'nh.notifications.connect': { request: NotificationSenderConnect; profile: ProfileInput }
	'nh.notifications.reset': Record<string, never>
	'nh.notifications.disconnect': NotificationSenderRequest
	'nh.notifications.send': NotificationSend
	'nh.notifications.result': NotificationSenderResult
	'nh.registrations.get': NotificationHubRegistrationInspect
	'nh.registrations.change': NotificationHubRegistrationChange
	'nh.registrations.result': NotificationHubRegistrationResult
	'nh.registrations.connect': {
		request: NotificationHubRegistrationsConnect
		profile: ProfileInput
	}
	'nh.registrations.reset': Record<string, never>
	'nh.registrations.jobs.list': NotificationHubRegistrationsRequest
	'nh.registrations.jobs.get': NotificationHubJobGet
	'nh.registrations.jobs.preview': NotificationHubJobPreview
	'nh.registrations.jobs.discard': NotificationHubRegistrationsRequest
	'nh.registrations.jobs.submit': NotificationHubJobSubmit
	'nh.registrations.jobs.result': NotificationHubRegistrationResult
	'nh.registrations.disconnect': NotificationHubRegistrationsRequest
	'nh.registrations.query': NotificationHubRegistrationsQuery
	'nh.registrations.inspect': NotificationHubRegistrationInspect
	'nh.registrations.files.export': RegistrationFileExport
	'nh.registrations.files.preview': NotificationHubRegistrationsRequest & {
		contentBase64: string
	}
	'nh.registrations.files.inspect': RegistrationFileInspect
	'nh.registrations.files.apply': RegistrationFileApply
	'nh.registrations.files.result': NotificationHubRegistrationResult
	'nh.config.export': NotificationHubConfigExport
	'nh.config.preview': NotificationHubRequest & { contentBase64: string }
	'nh.config.apply': NotificationHubConfigApply
	'nh.config.result': NotificationHubResult
	'nh.connect': {
		operationId: string
		profile: ProfileInput
		management: NotificationHubManagement
	}
	'nh.reset': Record<string, never>
	'nh.disconnect': NotificationHubRequest
	'nh.list': NotificationHubList
	'nh.get': NotificationHubGet
	'nh.credentials.get': CredentialGet
	'nh.credentials.import': CredentialImport & { contentBase64: string }
	'nh.credentials.discard': CredentialDiscard
	'nh.credentials.change': CredentialChange
	'nh.change': NotificationHubChange
	'nh.result': NotificationHubResult
	'nh.key': NotificationHubKey
}

export const notificationHubsBackendResults = {
	'nh.notifications.connect': nhNotificationsConnectionSchema,
	'nh.notifications.reset': z.null(),
	'nh.notifications.disconnect': z.null(),
	'nh.notifications.send': notificationOutcomeSchema,
	'nh.notifications.result': notificationOutcomeSchema.nullable(),
	'nh.registrations.get': nhRegistrationDetailsSchema,
	'nh.registrations.change': nhRegistrationOutcomeSchema,
	'nh.registrations.result': nhRegistrationOutcomeSchema.nullable(),
	'nh.registrations.connect': nhRegistrationsConnectionSchema,
	'nh.registrations.reset': z.null(),
	'nh.registrations.jobs.list': nhJobsPageSchema,
	'nh.registrations.jobs.get': nhJobSchema,
	'nh.registrations.jobs.preview': nhJobReviewSchema,
	'nh.registrations.jobs.discard': z.null(),
	'nh.registrations.jobs.submit': nhJobOutcomeSchema,
	'nh.registrations.jobs.result': nhJobOutcomeSchema.nullable(),
	'nh.registrations.disconnect': z.null(),
	'nh.registrations.query': nhRegistrationsPageSchema,
	'nh.registrations.inspect': nhRegistrationDetailsSchema,
	'nh.registrations.files.export': registrationFileEncodedSchema,
	'nh.registrations.files.preview': registrationFilePreviewSchema,
	'nh.registrations.files.inspect': registrationFileDetailsSchema,
	'nh.registrations.files.apply': registrationFileResultSchema,
	'nh.registrations.files.result': registrationFileResultSchema.nullable(),
	'nh.config.export': nhConfigEncodedSchema,
	'nh.config.preview': nhConfigPreviewSchema,
	'nh.config.apply': nhConfigResultSchema,
	'nh.config.result': nhConfigResultSchema.nullable(),
	'nh.connect': nhConnectionSchema,
	'nh.reset': z.null(),
	'nh.disconnect': z.null(),
	'nh.list': nhPageSchema,
	'nh.get': nhDetailsSchema,
	'nh.credentials.get': credentialStatusSchema,
	'nh.credentials.import': credentialArtifactSchema,
	'nh.credentials.discard': z.null(),
	'nh.credentials.change': nhOutcomeSchema,
	'nh.change': nhOutcomeSchema,
	'nh.result': nhOutcomeSchema.nullable(),
	'nh.key': nhKeyResultSchema,
}
