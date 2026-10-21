import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import {
	backendEventSchema,
	backendResults,
	MAX_FRAME_BYTES,
	MAX_PENDING,
	PROTOCOL_VERSION,
	type BackendMethods,
	type BackendStatus,
} from '../../shared/contracts'
import { encodeFrame, FrameDecoder } from './transport/framing'

const responseSchema = z.union([
	z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() }).strict(),
	z
		.object({
			jsonrpc: z.literal('2.0'),
			id: z.string(),
			error: z.object({ code: z.number(), message: z.string().max(1024) }).strict(),
		})
		.strict(),
	z
		.object({
			jsonrpc: z.literal('2.0'),
			method: z.literal('event'),
			params: backendEventSchema,
		})
		.strict(),
])
export class HostError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message)
	}
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }

export class Backend extends EventEmitter {
	status: BackendStatus = { state: 'stopped', detail: 'Backend has not started.' }
	private child?: ChildProcessWithoutNullStreams
	private pending = new Map<string, Pending>()
	private starting?: Promise<void>
	private stopping = false
	constructor(
		private readonly command: string,
		private readonly args: string[] = [],
	) {
		super()
	}
	private update(status: BackendStatus) {
		this.status = status
		this.emit('status', status)
	}
	async start(): Promise<void> {
		if (this.starting) return this.starting
		if (this.status.state === 'ready') return
		this.starting = this.launch().finally(() => {
			this.starting = undefined
		})
		return this.starting
	}
	private async launch() {
		this.stopping = false
		this.update({ state: 'starting', detail: 'Starting the bundled .NET host…' })
		const child = spawn(this.command, this.args, {
			stdio: 'pipe',
			windowsHide: true,
			shell: false,
		})
		this.child = child
		const decoder = new FrameDecoder()
		child.stdout.on('data', (chunk: Buffer) => {
			if (this.child !== child) return
			try {
				for (const value of decoder.push(chunk)) {
					const response = responseSchema.parse(value)
					if ('method' in response) {
						this.emit('event', response.params)
						continue
					}
					const pending = this.pending.get(response.id)
					if (!pending) continue // A late response after cancellation/timeout.
					this.pending.delete(response.id)
					pending.cleanup()
					if ('error' in response)
						pending.reject(
							new HostError(String(response.error.code), response.error.message),
						)
					else pending.resolve(response.result)
				}
			} catch {
				this.fail('The backend sent an invalid protocol frame.')
				child.kill()
			}
		})
		// Never forward arbitrary SDK stderr (which may contain credentials) into the UI/log file.
		child.stderr.on('data', () => {})
		child.stdin.on('error', () => {
			if (this.child === child) this.fail('The backend pipe closed.')
		})
		child.on('error', () => {
			if (this.child === child)
				this.fail(
					'The bundled backend could not start. Reinstall or rebuild the application.',
				)
		})
		child.on('exit', () => {
			if (this.child !== child) return
			this.child = undefined
			if (!this.stopping)
				this.fail(
					decoder.hasPartialFrame
						? 'The backend closed during a response.'
						: 'The backend stopped unexpectedly. Restart it to continue.',
				)
		})
		try {
			const hello = await this.request(
				'host.hello',
				{ protocolVersion: PROTOCOL_VERSION },
				{ timeout: 15000 },
			)
			if (this.child !== child || this.stopping)
				throw new HostError('STOPPED', 'Backend stopped during startup.')
			this.update({
				state: 'ready',
				detail: 'Private process connection established.',
				runtime: hello.runtime,
			})
		} catch (error) {
			child.kill()
			this.fail('Backend startup failed. Check the bundled runtime.')
			throw error
		}
	}
	private fail(message: string) {
		for (const entry of this.pending.values()) {
			entry.cleanup()
			entry.reject(new HostError('BACKEND_UNAVAILABLE', message))
		}
		this.pending.clear()
		if (!this.stopping) this.update({ state: 'crashed', detail: message })
	}
	async request<K extends keyof BackendMethods>(
		method: K,
		params: BackendMethods[K]['params'],
		options: { signal?: AbortSignal; timeout?: number; waitForCancellation?: boolean } = {},
	): Promise<BackendMethods[K]['result']> {
		const child = this.child
		if (!child || child.killed || this.stopping)
			throw new HostError(
				'BACKEND_UNAVAILABLE',
				'Backend is unavailable. Restart it to continue.',
			)
		if (this.pending.size >= MAX_PENDING)
			throw new HostError('BUSY', 'Too many operations. Wait for one to finish.')
		if (options.signal?.aborted) throw new HostError('CANCELLED', 'Operation cancelled.')
		const id = randomUUID()
		const frame = encodeFrame({ jsonrpc: '2.0', id, method, params })
		if (child.stdin.writableLength + frame.length > MAX_FRAME_BYTES * MAX_PENDING)
			throw new HostError(
				'BUSY',
				'The backend input pipe is full. Wait or restart the backend.',
			)
		const value = await new Promise<unknown>((resolve, reject) => {
			const cancel = (code: string, message: string) => {
				if (!this.pending.delete(id)) return
				cleanup()
				if (!child.stdin.destroyed && !child.killed) {
					if (child.stdin.writableLength > MAX_FRAME_BYTES * MAX_PENDING) child.kill()
					else
						child.stdin.write(
							encodeFrame({
								jsonrpc: '2.0',
								method: '$/cancelRequest',
								params: { id },
							}),
						)
				}
				reject(new HostError(code, message))
			}
			// Purge needs the host's final partial counts after cancellation. Keep its pending
			// response and deadline while requesting a stop; never repeat the request.
			const abort = () => {
				if (!options.waitForCancellation) return cancel('CANCELLED', 'Operation cancelled.')
				if (!child.stdin.destroyed && !child.killed)
					child.stdin.write(
						encodeFrame({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }),
					)
			}
			const timer = setTimeout(
				() =>
					cancel(
						'TIMEOUT',
						'The operation timed out. Its outcome may be unknown; it was not retried.',
					),
				options.timeout ?? 30000,
			)
			const cleanup = () => {
				clearTimeout(timer)
				options.signal?.removeEventListener('abort', abort)
			}
			this.pending.set(id, { resolve, reject, cleanup })
			options.signal?.addEventListener('abort', abort, { once: true })
			child.stdin.write(frame, (error) => {
				if (error && this.child === child) this.fail('Unable to write to the backend.')
			})
		})
		return backendResults[method].parse(value) as BackendMethods[K]['result']
	}
	async stop() {
		this.stopping = true
		this.fail('Backend stopped. Operations were not retried.')
		const child = this.child
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					child.kill('SIGKILL')
					resolve()
				}, 2000)
				child.once('exit', () => {
					clearTimeout(timer)
					resolve()
				})
				child.stdin.end()
			})
		}
		this.child = undefined
		this.update({ state: 'stopped', detail: 'Backend stopped.' })
	}
	async restart() {
		await this.stop()
		await this.start()
	}
}
