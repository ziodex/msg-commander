import { Backend, HostError } from '../../../platform/backend'
import type { Profile, ProfileInput } from '../../../../shared/contracts'
import type { NotificationHubConnection } from '../../../../shared/contracts/notification-hubs/core'
import type { NotificationHubJobSubmit } from '../../../../shared/contracts/notification-hubs/jobs'
import type {
	NotificationHubRegistrationChange,
	NotificationHubRegistrationsConnect,
	NotificationHubRegistrationsConnection,
	NotificationHubRegistrationsQuery,
	NotificationHubRegistrationInspect,
} from '../../../../shared/contracts/notification-hubs/registrations'
export class NotificationHubRegistrationsController {
	private active?: NotificationHubRegistrationsConnection
	private generation = 0
	private resetting: Promise<void> = Promise.resolve()
	constructor(
		private backend: Backend,
		private requireManagement: (id: string) => NotificationHubConnection,
		private resolveSecret: (id: string) => ProfileInput,
		private onReset: () => void,
	) {}
	forget() {
		this.generation++
		this.active = undefined
		this.onReset()
	}
	reset() {
		this.forget()
		this.resetting = this.resetting
			.catch(() => {})
			.then(async () => {
				if (this.backend.status.state === 'ready')
					await this.backend.request('nh.registrations.reset', {})
			})
		return this.resetting
	}
	async connect(
		request: NotificationHubRegistrationsConnect,
		profile: Profile | undefined,
		signal: AbortSignal,
	) {
		if (!profile || profile.id !== request.profileId || profile.service !== 'notification-hubs')
			throw new HostError('INVALID_PROFILE', 'Choose the matching Notification Hubs profile.')
		if (request.source === 'profile' && profile.auth !== 'sas')
			throw new HostError(
				'CREDENTIAL_REQUIRED',
				'Use a SAS profile or explicitly select a Manage policy from the management workspace.',
			)
		if (
			request.source === 'policy' &&
			this.requireManagement(request.managementConnectionId!).profileId !== profile.id
		)
			throw new HostError(
				'INVALID_PROFILE',
				'Use the matching Notification Hubs management connection.',
			)
		const ticket = ++this.generation
		this.active = undefined
		await this.resetting
		if (ticket !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Registration connection cancelled.')
		const { secretState: _state, ...metadata } = profile
		// Unlock only after the user explicitly connects with a saved SAS profile.
		const backendProfile =
			request.source === 'profile'
				? this.resolveSecret(profile.id)
				: { ...metadata, rememberSecret: false }
		const connection = await this.backend.request(
			'nh.registrations.connect',
			{ request, profile: backendProfile },
			{ signal, timeout: 60000 },
		)
		if (ticket !== this.generation || signal.aborted) {
			await this.backend
				.request('nh.registrations.disconnect', {
					id: request.id,
					connectionId: connection.connectionId,
				})
				.catch(() => {})
			throw new HostError('CANCELLED', 'Registration connection cancelled.')
		}
		if (connection.managementConnectionId)
			this.requireManagement(connection.managementConnectionId)
		this.active = connection
		return connection
	}
	require(id: string) {
		if (this.active?.connectionId !== id)
			throw new HostError('CONNECTION_EXPIRED', 'Connect registrations again.')
		if (this.active.managementConnectionId)
			this.requireManagement(this.active.managementConnectionId)
		return this.active
	}
	async query(request: NotificationHubRegistrationsQuery, signal: AbortSignal) {
		this.require(request.connectionId)
		const ticket = this.generation
		const result = await this.backend.request('nh.registrations.query', request, {
			signal,
			timeout: 45000,
		})
		if (ticket !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Registration query cancelled.')
		this.require(request.connectionId)
		return result
	}
	async inspect(request: NotificationHubRegistrationInspect, signal: AbortSignal) {
		this.require(request.connectionId)
		const ticket = this.generation
		const result = await this.backend.request('nh.registrations.inspect', request, { signal })
		if (ticket !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Registration inspection cancelled.')
		this.require(request.connectionId)
		return result
	}
	async get(request: NotificationHubRegistrationInspect, signal: AbortSignal) {
		this.require(request.connectionId)
		const ticket = this.generation
		const result = await this.backend.request('nh.registrations.get', request, {
			signal,
			timeout: 45000,
		})
		if (ticket !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Registration reload cancelled.')
		this.require(request.connectionId)
		return result
	}
	async change(request: NotificationHubRegistrationChange, signal: AbortSignal) {
		this.require(request.connectionId)
		const ticket = this.generation
		try {
			const result = await this.backend.request('nh.registrations.change', request, {
				signal,
				timeout: 45000,
				waitForCancellation: true,
			})
			if (ticket !== this.generation)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'Connection changed during this registration write. Review Azure state.',
				)
			return result
		} catch (error) {
			if (
				!(error instanceof HostError) ||
				[
					'TIMEOUT',
					'CANCELLED',
					'-32800',
					'BACKEND_UNAVAILABLE',
					'INVALID_REQUEST',
				].includes(error.code)
			)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'Final registration receipt unavailable. Review Azure state before another write. Nothing was retried.',
				)
			throw error
		}
	}
	async disconnect(id: string) {
		this.require(id)
		await this.reset()
	}
	async submitJob(request: NotificationHubJobSubmit, signal: AbortSignal) {
		this.require(request.connectionId)
		const ticket = this.generation
		try {
			const result = await this.backend.request('nh.registrations.jobs.submit', request, {
				signal,
				timeout: 45000,
				waitForCancellation: true,
			})
			if (ticket !== this.generation)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'Connection changed during bulk job submission. Refresh Azure jobs before submitting again.',
				)
			return result
		} catch (error) {
			if (
				!(error instanceof HostError) ||
				[
					'TIMEOUT',
					'CANCELLED',
					'-32800',
					'BACKEND_UNAVAILABLE',
					'INVALID_REQUEST',
				].includes(error.code)
			)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'Bulk job receipt unavailable. Refresh Azure jobs and review Azure state before another submission. Nothing was retried.',
				)
			throw error
		}
	}
}
