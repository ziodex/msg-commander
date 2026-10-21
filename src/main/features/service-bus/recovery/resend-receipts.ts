import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HostError, type Backend } from '../../../platform/backend'
import { atomicFile } from '../files/message-files'
import type { WorkspaceStore } from '../../../platform/workspace-store'
import type {
	ResendRequest,
	ResendResultRequest,
} from '../../../../shared/contracts/service-bus/maintenance/index'
import type { FileResult } from '../../../../shared/message-files'

export function resolveResendDestination(
	request: ResendRequest,
	workspace: Pick<WorkspaceStore, 'list' | 'getForBackend'>,
) {
	if (!request.destinationProfileId) return undefined
	// Validate public metadata before asking the OS to decrypt an explicitly selected credential.
	const profile = workspace.list().find((p) => p.id === request.destinationProfileId)
	if (
		!profile ||
		profile.service !== 'service-bus' ||
		profile.namespace !== request.destinationNamespace
	)
		throw new HostError(
			'DESTINATION_CHANGED',
			'Destination connection changed. Select the saved Service Bus profile and review it again.',
		)
	return workspace.getForBackend(profile.id)
}

export async function saveResendReceipt(
	request: ResendResultRequest,
	signal: AbortSignal,
	backend: Pick<Backend, 'request'>,
	requireConnection: (id: string) => void,
	save: () => Promise<string | undefined>,
): Promise<FileResult> {
	const check = () => {
		requireConnection(request.connectionId)
		if (signal.aborted) throw new HostError('CANCELLED', 'Receipt export cancelled.')
	}
	check()
	const result = await backend.request(
		'sb.deadletters.result',
		{ ...request, id: randomUUID() },
		{ signal, timeout: 60000 },
	)
	if (!result)
		throw new HostError(
			'RECEIPT_EXPIRED',
			'No retained resend receipt is available. Nothing was resent.',
		)
	const path = await save()
	check()
	if (!path) return { cancelled: true }
	try {
		await atomicFile(path, 2 * 1024 * 1024, signal, async (write) => {
			check()
			await write(
				JSON.stringify(
					{
						format: 'msg-commander-resend-receipt',
						version: 1,
						savedAtUtc: new Date().toISOString(),
						result,
					},
					null,
					2,
				) + '\n',
			)
		})
	} catch (error) {
		if (error instanceof HostError) throw error
		throw new HostError(
			'RECEIPT_FILE',
			'The receipt could not be saved. Check file access and disk space. No messages were sent or settled.',
		)
	}
	return { cancelled: false, fileName: basename(path), count: result.transfers.length }
}
