import type {
	EventGridReceive,
	EventGridSettle,
	EventGridPullTarget,
	EventGridPullInspect,
	EventGridPullResultRequest,
} from '../../../shared/contracts/event-grid/pulling'
import type {
	EventGridPublish,
	EventGridPublishResultRequest,
} from '../../../shared/contracts/event-grid/publishing'
import type {
	EventGridAdminChange,
	EventGridAdminResult,
} from '../../../shared/contracts/event-grid/administration'
import { Backend, HostError } from '../../platform/backend'
import type { Profile } from '../../../shared/contracts'
import { eventGridHostSchema } from '../../../shared/contracts/event-grid/core'
import type {
	EventGridConnect,
	EventGridConnection,
	EventGridGet,
	EventGridList,
} from '../../../shared/contracts/event-grid/core'
export class EventGridController {
	private active?: EventGridConnection
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
					await this.backend.request('eg.reset', {})
			})
		return this.resetting
	}
	require(id: string) {
		if (this.active?.connectionId !== id)
			throw new HostError('CONNECTION_EXPIRED', 'Connect to this Event Grid namespace again.')
		return this.active
	}
	async connect(value: EventGridConnect, profile: Profile | undefined, signal: AbortSignal) {
		if (
			!profile ||
			profile.id !== value.profileId ||
			profile.service !== 'event-grid' ||
			profile.auth !== 'device-code' ||
			!eventGridHostSchema.safeParse(profile.namespace).success ||
			value.management.resourceId.split('/').at(-1)?.toLowerCase() !==
				profile.namespace.split('.')[0].toLowerCase()
		)
			throw new HostError(
				'INVALID_PROFILE',
				'Choose a matching Event Grid Entra profile and namespace resource ID.',
			)
		const ticket = ++this.generation
		this.active = undefined
		await this.resetting
		signal.throwIfAborted()
		if (ticket !== this.generation)
			throw new HostError('CANCELLED', 'Event Grid connection cancelled.')
		const { secretState: _state, ...metadata } = profile
		const connection = await this.backend.request(
			'eg.connect',
			{
				operationId: value.id,
				profile: { ...metadata, rememberSecret: false },
				management: value.management,
			},
			{ signal, timeout: 300000 },
		)
		if (ticket !== this.generation || signal.aborted) {
			await this.backend.request('eg.disconnect', {
				id: value.id,
				connectionId: connection.connectionId,
			})
			throw new HostError('CANCELLED', 'Event Grid connection cancelled.')
		}
		this.active = connection
		return connection
	}
	async list(value: EventGridList, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.list', value, { signal, timeout: 315000 })
		signal.throwIfAborted()
		if (ticket !== this.generation)
			throw new HostError('CANCELLED', 'Event Grid read cancelled.')
		this.require(value.connectionId)
		return result
	}
	async get(value: EventGridGet, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.get', value, { signal, timeout: 315000 })
		signal.throwIfAborted()
		if (ticket !== this.generation)
			throw new HostError('CANCELLED', 'Event Grid read cancelled.')
		this.require(value.connectionId)
		return result
	}
	async adminGet(value: EventGridGet, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.admin.get', value, {
			signal,
			timeout: 315000,
		})
		signal.throwIfAborted()
		if (ticket !== this.generation)
			throw new HostError('CANCELLED', 'Event Grid read cancelled.')
		this.require(value.connectionId)
		return result
	}
	async change(value: EventGridAdminChange, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.admin.change', value, {
			signal,
			timeout: 615000,
			waitForCancellation: true,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Reconnect and inspect Azure before another change.',
			)
		this.require(value.connectionId)
		return result
	}
	async result(value: EventGridAdminResult, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.admin.result', value, {
			signal,
			timeout: 315000,
		})
		if (ticket !== this.generation)
			throw new HostError('CONNECTION_EXPIRED', 'Event Grid connection expired.')
		return result
	}
	async publish(value: EventGridPublish, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.publish', value, {
			signal,
			timeout: 315000,
			waitForCancellation: true,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Review publishing in Azure before sending again.',
			)
		this.require(value.connectionId)
		return result
	}
	async publishResult(value: EventGridPublishResultRequest, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.publish.result', value, {
			signal,
			timeout: 315000,
		})
		if (ticket !== this.generation)
			throw new HostError('CONNECTION_EXPIRED', 'Event Grid connection expired.')
		return result
	}
	async receive(value: EventGridReceive, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.receive', value, {
			signal,
			timeout: 335000,
			waitForCancellation: true,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async settle(value: EventGridSettle, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.settle', value, {
			signal,
			timeout: 335000,
			waitForCancellation: true,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async received(value: EventGridPullTarget, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.list', value, {
			signal,
			timeout: 335000,
			waitForCancellation: false,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async clearReceived(value: EventGridPullTarget, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.clear', value, {
			signal,
			timeout: 335000,
			waitForCancellation: false,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async inspectReceived(value: EventGridPullInspect, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.inspect', value, {
			signal,
			timeout: 335000,
			waitForCancellation: false,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async pullResult(value: EventGridPullResultRequest, signal: AbortSignal) {
		const ticket = this.generation
		this.require(value.connectionId)
		const result = await this.backend.request('eg.pull.result', value, {
			signal,
			timeout: 335000,
			waitForCancellation: false,
		})
		if (ticket !== this.generation)
			throw new HostError(
				'CONNECTION_EXPIRED',
				'Event Grid connection expired. Held locks expire in Azure; no events were automatically settled.',
			)
		this.require(value.connectionId)
		return result
	}
	async disconnect(id: string) {
		this.require(id)
		await this.reset()
	}
}
