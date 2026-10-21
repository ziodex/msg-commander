import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend, HostError } from '../../../src/main/platform/backend'
import type { BackendMethods } from '../../../src/shared/contracts'
import { emptyDraft } from '../../../src/main/features/service-bus/files/message-archive'
import { defaultEntitySettings, entityPath } from '../../../src/shared/entity-management'
import type { EntityTarget, PeekTarget, MessageSubQueue } from '../../../src/shared/service-bus'
import type { TestJobRequest } from '../../../src/shared/contracts/service-bus/test-jobs'
import { FaultProxy } from './fault-proxy'

class RecoveryBackend extends Backend {
	override async request<K extends keyof BackendMethods>(
		method: K,
		params: BackendMethods[K]['params'],
		options: { signal?: AbortSignal; timeout?: number; waitForCancellation?: boolean } = {},
	): Promise<BackendMethods[K]['result']> {
		try {
			return await super.request(method, params, options)
		} catch (error) {
			if (error instanceof HostError)
				throw new HostError(error.code, `Recovery ${method}: ${error.message}`)
			throw new Error(`Recovery ${method} failed`, { cause: error })
		}
	}
}

export function productionHost() {
	return process.env.COMMANDER_RECOVERY_HOST
		? new RecoveryBackend(resolve(process.env.COMMANDER_RECOVERY_HOST))
		: new RecoveryBackend('dotnet', [
				resolve('backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll'),
			])
}
export const emulatorProfile = (amqp = 5672, management = 5300) => ({
	id: randomUUID(),
	name: 'Docker recovery',
	service: 'service-bus' as const,
	namespace: 'localhost',
	auth: 'sas' as const,
	tenantId: '',
	clientId: '',
	rememberSecret: false,
	emulatorManagementPort: management,
	secret: `Endpoint=sb://localhost:${amqp};SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;`,
})
export class RecoveryHarness {
	host = productionHost()
	observer = productionHost()
	amqp: FaultProxy
	management: FaultProxy
	connectionId = ''
	observerId = ''
	profile = emulatorProfile()
	queue: PeekTarget = { kind: 'queue', name: `recovery-${randomUUID()}` }
	private created = false
	constructor(
		private readonly options: {
			amqpPort?: number
			managementPort?: number
			requiresSession?: boolean
			configuredQueue?: string
			messageTimeToLive?: string
		} = {},
	) {
		this.amqp = new FaultProxy(options.amqpPort ?? 5672)
		this.management = new FaultProxy(options.managementPort ?? 5300)
		if (options.configuredQueue) this.queue = { kind: 'queue', name: options.configuredQueue }
	}
	request() {
		return { id: randomUUID(), connectionId: this.connectionId }
	}
	control() {
		return { id: randomUUID(), connectionId: this.observerId }
	}
	async start() {
		if (!(await fetch(`http://127.0.0.1:${this.options.managementPort ?? 5300}/health`)).ok)
			throw new Error('Docker emulator is not healthy')
		await Promise.all([
			this.amqp.start(),
			this.management.start(),
			this.host.start(),
			this.observer.start(),
		])
		this.observerId = (
			await this.observer.request('sb.connect', {
				operationId: randomUUID(),
				profile: emulatorProfile(this.options.amqpPort, this.options.managementPort),
			})
		).connectionId
		if (!this.options.configuredQueue) {
			const result = await this.observer.request('sb.entity.create', {
				...this.control(),
				target: this.queue,
				settings: {
					...defaultEntitySettings('queue'),
					defaultMessageTimeToLive: this.options.messageTimeToLive ?? '01:00:00',
					lockDuration: '00:01:00',
					requiresSession: this.options.requiresSession ?? false,
				},
			})
			if (result.status !== 'confirmed')
				throw new Error(
					`Unable to create disposable recovery queue (${result.status}): ${result.summary}`,
				)
			this.created = true
		}
		this.profile = emulatorProfile(this.amqp.port, this.management.port)
		await this.connect()
	}
	async connect() {
		this.connectionId = (
			await this.host.request('sb.connect', {
				operationId: randomUUID(),
				profile: this.profile,
			})
		).connectionId
	}
	async reconnect() {
		await this.host.request('sb.disconnect', { connectionId: this.connectionId })
		await this.connect()
	}
	async reconnectObserver() {
		await this.observer.request('sb.disconnect', { connectionId: this.observerId })
		this.observerId = (
			await this.observer.request('sb.connect', {
				operationId: randomUUID(),
				profile: emulatorProfile(this.options.amqpPort, this.options.managementPort),
			})
		).connectionId
	}
	job(changes: Partial<TestJobRequest> = {}): TestJobRequest {
		return {
			...this.request(),
			target: this.queue,
			mode: 'send',
			maxMessages: 12,
			maxSeconds: 30,
			workers: 1,
			batchSize: 1,
			generator: { kind: 'literal', seed: 1, sizeBytes: 1024 },
			settlement: 'complete',
			deadLetterReason: '',
			deadLetterDescription: '',
			delayMs: 0,
			sessionId: '',
			body: '{"recovery":true}',
			contentType: 'application/json',
			acknowledged: true,
			...changes,
		}
	}
	async seed(count = 1, sessionId = '') {
		for (let index = 0; index < count; index++) {
			const result = await this.observer.request('sb.send', {
				...this.control(),
				target: this.queue as { kind: 'queue'; name: string },
				draft: { ...emptyDraft('eA=='), sessionId },
			})
			if (result.status !== 'confirmed') throw new Error('Unable to seed recovery queue')
		}
	}
	peek(subQueue: MessageSubQueue = 'active', observer = true) {
		return (observer ? this.observer : this.host).request('sb.peek', {
			...(observer ? this.control() : this.request()),
			target: this.queue,
			subQueue,
			fromSequenceNumber: '0',
			maxMessages: 25,
		})
	}
	receive(observer = false, deferredSequence?: string, sessionId = '') {
		return (observer ? this.observer : this.host).request('sb.receive', {
			...(observer ? this.control() : this.request()),
			target: this.queue,
			subQueue: 'active',
			sessionId,
			maxMessages: 1,
			waitSeconds: 1,
			...(deferredSequence ? { deferredSequence } : {}),
		})
	}
	async close() {
		this.amqp.restore()
		this.management.restore()
		try {
			await this.host.stop()
			if (this.observerId && this.created) {
				await this.observer.request('sb.close-receiver', this.control())
				const current = await this.observer.request('sb.entity-config', {
					...this.control(),
					target: this.queue,
				})
				const result = await this.observer.request('sb.entity.delete', {
					...this.control(),
					target: this.queue as EntityTarget,
					expectedRevision: current.revision,
					confirmation: entityPath(this.queue),
				})
				if (result.status !== 'confirmed')
					throw new Error('Unable to delete disposable recovery queue')
			}
		} finally {
			await Promise.all([this.observer.stop(), this.amqp.close(), this.management.close()])
		}
	}
}
