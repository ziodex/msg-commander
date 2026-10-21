import { parseIotEndpoint, type IotHubConnect } from '../../../shared/iot-hub'
import { Backend, HostError } from '../../platform/backend'
import type {
	EventHubsConnect,
	EventHubsConnection,
} from '../../../shared/contracts/event-hubs/core'
import type { ProfileInput } from '../../../shared/contracts'
export class EventHubsController {
	private active?: EventHubsConnection
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
	reset(): Promise<void> {
		this.forget()
		this.resetting = this.resetting
			.catch(() => {})
			.then(async () => {
				if (this.backend.status.state === 'ready')
					await this.backend.request('eh.reset', {})
			})
		return this.resetting
	}
	async connect(value: EventHubsConnect, profile: ProfileInput, signal: AbortSignal) {
		if (profile.service !== 'event-hubs' && profile.service !== 'iot-hub')
			throw new HostError('INVALID_PROFILE', 'Choose an Event Hubs profile.')
		if (profile.service === 'iot-hub') {
			let endpoint
			try {
				endpoint = parseIotEndpoint(profile.secret ?? '')
			} catch (error) {
				throw new HostError(
					'INVALID_PROFILE',
					error instanceof Error ? error.message : 'Invalid IoT Hub endpoint.',
				)
			}
			if (
				profile.auth !== 'sas' ||
				endpoint.namespace !== profile.namespace ||
				value.hubName !== endpoint.hubName ||
				value.management ||
				value.access === 'send'
			)
				throw new HostError(
					'INVALID_PROFILE',
					'IoT Hub supports read-only access to the built-in endpoint in this profile.',
				)
		}
		const generation = ++this.generation
		this.active = undefined
		await this.resetting
		if (generation !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Connection cancelled.')
		const connection = await this.backend.request(
			'eh.connect',
			{
				operationId: value.id,
				profile,
				hubName: value.hubName,
				access: value.access ?? 'read',
				management: value.management,
			},
			{ signal, timeout: 300000 },
		)
		if (generation !== this.generation || signal.aborted) {
			await this.backend.request('eh.disconnect', {
				id: value.id,
				connectionId: connection.connectionId,
			})
			throw new HostError('CANCELLED', 'Connection cancelled.')
		}
		this.active = connection
		return connection
	}
	async connectIot(value: IotHubConnect, profile: ProfileInput, signal: AbortSignal) {
		if (profile.service !== 'iot-hub')
			throw new HostError('INVALID_PROFILE', 'Choose an IoT Hub profile.')
		let endpoint
		try {
			endpoint = parseIotEndpoint(profile.secret ?? '')
		} catch (error) {
			throw new HostError(
				'INVALID_PROFILE',
				error instanceof Error ? error.message : 'Invalid IoT Hub endpoint.',
			)
		}
		return this.connect(
			{ ...value, hubName: endpoint.hubName, access: 'read', management: null },
			profile,
			signal,
		)
	}
	require(id: string) {
		if (this.active?.connectionId !== id)
			throw new HostError('CONNECTION_EXPIRED', 'Connect to this Event Hubs namespace again.')
		return this.active
	}
	async disconnect(id: string) {
		this.require(id)
		await this.reset()
	}
}
