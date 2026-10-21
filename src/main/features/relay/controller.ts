import type { Profile } from '../../../shared/contracts'
import type { RelayConnect, RelayConnection } from '../../../shared/contracts/relay/core'
import { Backend, HostError } from '../../platform/backend'
export class RelayController {
	private active?: RelayConnection
	private generation = 0
	private resetting: Promise<void> = Promise.resolve()
	constructor(
		private backend: Backend,
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
					await this.backend.request('relay.reset', {})
			})
		return this.resetting
	}
	async connect(value: RelayConnect, profile: Profile | undefined, signal: AbortSignal) {
		if (!profile || profile.service !== 'relay')
			throw new HostError('INVALID_PROFILE', 'Choose a Relay profile.')
		if (
			value.management.resourceId.split('/').at(-1)?.toLowerCase() +
				'.servicebus.windows.net' !==
			profile.namespace.toLowerCase()
		)
			throw new HostError(
				'INVALID_PROFILE',
				'The Relay resource ID must match this namespace.',
			)
		const generation = ++this.generation
		this.active = undefined
		await this.resetting
		if (generation !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Relay connection cancelled.')
		// Management doesn't require or unlock the profile's data-plane SAS secret.
		const { secretState: _state, ...publicProfile } = profile
		const connection = await this.backend.request(
			'relay.connect',
			{
				operationId: value.id,
				profile: { ...publicProfile, rememberSecret: false },
				management: value.management,
			},
			{ signal, timeout: 300000 },
		)
		if (generation !== this.generation || signal.aborted) {
			await this.backend.request('relay.disconnect', {
				id: value.id,
				connectionId: connection.connectionId,
			})
			throw new HostError('CANCELLED', 'Relay connection cancelled.')
		}
		this.active = connection
		return connection
	}
	require(id: string) {
		if (this.active?.connectionId !== id)
			throw new HostError('CONNECTION_EXPIRED', 'Connect to this Relay namespace again.')
		return this.active
	}
	async disconnect(id: string) {
		this.require(id)
		await this.reset()
	}
}
