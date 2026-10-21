import { basename } from 'node:path'
import { Backend, HostError } from '../../platform/backend'
import { atomicFile, readBounded } from '../service-bus/files/message-files'
import type {
	MessagingService,
	MessagingConfigRequest,
	MessagingConfigExport,
	MessagingConfigImportResult,
} from '../../../shared/contracts/resource-configuration'
export class MessagingConfigurationFiles {
	constructor(
		private backend: Pick<Backend, 'request'>,
		private requireConnection: (service: MessagingService, id: string) => void,
		private dialogs: {
			open(service: MessagingService): Promise<string | undefined>
			save(service: MessagingService, format: 'json'): Promise<string | undefined>
		},
	) {}
	private check(request: MessagingConfigRequest, signal: AbortSignal) {
		signal.throwIfAborted()
		this.requireConnection(request.service, request.connectionId)
	}
	private async guard<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action()
		} catch (error) {
			if (error instanceof HostError) throw error
			if (error instanceof Error && error.name === 'AbortError')
				throw new HostError(
					'CANCELLED',
					'Configuration file operation cancelled. No Azure writes were requested.',
				)
			throw new HostError(
				'CONFIGURATION_FILE',
				'Configuration could not be read or saved. Check the file format, permissions, available disk space and 512 KiB limit. No Azure writes were requested.',
			)
		}
	}
	async import(
		request: MessagingConfigRequest,
		signal: AbortSignal,
	): Promise<MessagingConfigImportResult> {
		return this.guard(async () => {
			this.check(request, signal)
			await this.backend.request(
				request.service === 'service-bus' ? 'sb.config.discard' : 'eh.config.discard',
				request,
				{ signal },
			)
			const path = await this.dialogs.open(request.service)
			this.check(request, signal)
			if (!path) return { cancelled: true, preview: null }
			const bytes = await readBounded(path, 524288, signal, '512 KiB')
			this.check(request, signal)
			const preview = await this.backend.request(
				request.service === 'service-bus' ? 'sb.config.preview' : 'eh.config.preview',
				{ ...request, contentBase64: bytes.toString('base64') },
				{ signal, timeout: 130000 },
			)
			this.check(request, signal)
			return { cancelled: false, fileName: basename(path), preview }
		})
	}
	async export(request: MessagingConfigExport, signal: AbortSignal) {
		return this.guard(async () => {
			this.check(request, signal)
			const path = await this.dialogs.save(request.service, request.format)
			this.check(request, signal)
			if (!path) return { cancelled: true }
			const value = await this.backend.request(
				request.service === 'service-bus' ? 'sb.config.export' : 'eh.config.export',
				request,
				{ signal, timeout: 130000 },
			)
			this.check(request, signal)
			const bytes = Buffer.from(value.contentBase64, 'base64')
			if (bytes.length > 524288 || bytes.toString('base64') !== value.contentBase64)
				throw new HostError('CONFIGURATION_FILE', 'Invalid configuration export.')
			await atomicFile(path, 524288, signal, async (write) => {
				await write(bytes)
				this.check(request, signal)
			})
			return {
				cancelled: false,
				fileName: basename(path),
				count: value.count,
				warnings: value.warnings,
			}
		})
	}
}
