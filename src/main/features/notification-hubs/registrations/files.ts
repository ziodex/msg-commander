import { basename } from 'node:path'
import { Backend, HostError } from '../../../platform/backend'
import { atomicFile, readBounded } from '../../service-bus/files/message-files'
import type {
	RegistrationFileExport,
	RegistrationFileImportResult,
} from '../../../../shared/contracts/notification-hubs/registration-files'
import type { NotificationHubRegistrationsRequest } from '../../../../shared/contracts/notification-hubs/registrations'
export class NotificationHubRegistrationFiles {
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
					'Registration file operation cancelled. No registration changes were requested.',
				)
			throw new HostError(
				'NH_REGISTRATION_FILE',
				'Registration file could not be read or saved. Check format, access, disk space and the 512 KiB limit. No registration changes were requested.',
			)
		}
	}
	export(request: RegistrationFileExport, signal: AbortSignal) {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const path = await this.dialogs.save(request.format)
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true }
			const value = await this.backend.request('nh.registrations.files.export', request, {
				signal,
			})
			this.check(request.connectionId, signal)
			const bytes = Buffer.from(value.contentBase64, 'base64')
			if (bytes.length > 524288 || bytes.toString('base64') !== value.contentBase64)
				throw new HostError('NH_REGISTRATION_FILE', 'Invalid registration export.')
			await atomicFile(path, 524288, signal, async (write) => {
				await write(bytes)
				this.check(request.connectionId, signal)
			})
			return { cancelled: false, fileName: basename(path), count: value.count }
		})
	}
	import(
		request: NotificationHubRegistrationsRequest,
		signal: AbortSignal,
	): Promise<RegistrationFileImportResult> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const path = await this.dialogs.open()
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true, preview: null }
			const bytes = await readBounded(path, 524288, signal, '512 KiB')
			this.check(request.connectionId, signal)
			const preview = await this.backend.request(
				'nh.registrations.files.preview',
				{ ...request, contentBase64: bytes.toString('base64') },
				{ signal },
			)
			this.check(request.connectionId, signal)
			return { cancelled: false, fileName: basename(path), preview }
		})
	}
}
