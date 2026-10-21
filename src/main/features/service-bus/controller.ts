import { Backend, HostError } from '../../platform/backend'
import type { NamespaceConnection } from '../../../shared/service-bus'
import type { ProfileInput } from '../../../shared/contracts'

// Only one active namespace; profile edits/reloads/restarts invalidate its handles.
export class ServiceBusController {
	private active?: NamespaceConnection
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
					await this.backend.request('sb.reset', {})
			})
		return this.resetting
	}
	async connect(operationId: string, profile: ProfileInput, signal: AbortSignal) {
		const generation = ++this.generation
		this.active = undefined
		await this.resetting
		if (generation !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Connection attempt cancelled.')
		const connection = await this.backend.request(
			'sb.connect',
			{ operationId, profile },
			{ signal, timeout: 300000 },
		)
		if (generation !== this.generation || signal.aborted) {
			await this.backend.request('sb.disconnect', { connectionId: connection.connectionId })
			throw new HostError('CANCELLED', 'Connection attempt cancelled.')
		}
		this.active = connection
		return connection
	}
	require(connectionId: string) {
		if (this.active?.connectionId !== connectionId)
			throw new HostError('CONNECTION_EXPIRED', 'Connect to this namespace again.')
	}
	async disconnect(connectionId: string) {
		this.require(connectionId)
		await this.reset()
	}
}
