import { Backend, HostError } from '../../../platform/backend'
import { readBounded } from '../../service-bus/files/message-files'
import type {
	CredentialImport,
	CredentialImportResult,
} from '../../../../shared/contracts/notification-hubs/credentials'
export class NotificationHubCredentialFiles {
	constructor(
		private backend: Pick<Backend, 'request'>,
		private requireConnection: (id: string) => unknown,
		private open: (provider: CredentialImport['provider']) => Promise<string | undefined>,
	) {}
	async import(request: CredentialImport, signal: AbortSignal): Promise<CredentialImportResult> {
		const check = () => {
			signal.throwIfAborted()
			this.requireConnection(request.connectionId)
		}
		try {
			check()
			const path = await this.open(request.provider)
			check()
			if (!path) return { cancelled: true, artifact: null }
			const bytes = await readBounded(path, 262144, signal, '256 KiB')
			try {
				check()
				const artifact = await this.backend.request(
					'nh.credentials.import',
					{ ...request, contentBase64: bytes.toString('base64') },
					{ signal, timeout: 60000 },
				)
				check()
				return { cancelled: false, artifact }
			} finally {
				bytes.fill(0)
			}
		} catch (error) {
			if (error instanceof HostError) throw error
			if (signal.aborted)
				throw new HostError(
					'CANCELLED',
					'Credential import cancelled. No Azure changes were requested.',
				)
			throw new HostError(
				'CREDENTIAL_IMPORT',
				'Credential file could not be read or validated. Check the file, password and 256 KiB limit. No Azure changes were requested.',
			)
		}
	}
}
