import { basename } from 'node:path'
import { Backend, HostError } from '../../../platform/backend'
import { atomicFile, readBounded } from '../../service-bus/files/message-files'
import type {
	NotificationHubConfigExport,
	NotificationHubConfigImportResult,
} from '../../../../shared/contracts/notification-hubs/configuration'
import type { NotificationHubRequest } from '../../../../shared/contracts/notification-hubs/core'
const LIMIT = 262144
export class NotificationHubFiles {
	constructor(
		private backend: Pick<Backend, 'request'>,
		private requireConnection: (id: string) => unknown,
		private dialogs: {
			open(): Promise<string | undefined>
			save(format: 'json' | 'xml'): Promise<string | undefined>
		},
	) {}
	private check(id: string, signal: AbortSignal) {
		signal.throwIfAborted()
		this.requireConnection(id)
	}
	private async guard<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action()
		} catch (error) {
			if (error instanceof HostError) throw error
			if (error instanceof Error && error.name === 'AbortError')
				throw new HostError(
					'CANCELLED',
					'Notification Hubs file operation cancelled. No Azure changes were requested.',
				)
			throw new HostError(
				'NH_CONFIG_FILE',
				'Notification Hubs configuration could not be read or saved. Check the format, file access, available disk space and the 256 KiB limit. No Azure changes were requested.',
			)
		}
	}
	async export(request: NotificationHubConfigExport, signal: AbortSignal) {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const path = await this.dialogs.save(request.format)
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true }
			const value = await this.backend.request('nh.config.export', request, {
				signal,
				timeout: 130000,
			})
			this.check(request.connectionId, signal)
			const bytes = Buffer.from(value.contentBase64, 'base64')
			if (bytes.length > LIMIT || bytes.toString('base64') !== value.contentBase64)
				throw new HostError(
					'NH_CONFIG_FILE',
					'Invalid Notification Hubs configuration export.',
				)
			await atomicFile(path, LIMIT, signal, async (write) => {
				await write(bytes)
				this.check(request.connectionId, signal)
			})
			return {
				cancelled: false,
				fileName: basename(path),
				count: value.count,
				warnings: value.warnings,
			}
		})
	}
	async import(
		request: NotificationHubRequest,
		signal: AbortSignal,
	): Promise<NotificationHubConfigImportResult> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const path = await this.dialogs.open()
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true, preview: null }
			const bytes = await readBounded(path, LIMIT, signal, '256 KiB')
			this.check(request.connectionId, signal)
			const preview = await this.backend.request(
				'nh.config.preview',
				{ ...request, contentBase64: bytes.toString('base64') },
				{ signal, timeout: 130000 },
			)
			this.check(request.connectionId, signal)
			return { cancelled: false, fileName: basename(path), preview }
		})
	}
}
