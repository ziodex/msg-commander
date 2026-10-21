import { serviceBusApi } from '@/features/service-bus/api'

import type { MessageSummary } from '@shared/service-bus'

import type { MessageDraft } from '@shared/message-operations'
import type {
	FileResult,
	ImportPreview,
	ImportedDrafts,
	LoadImportedRequest,
} from '@shared/message-files'
import type { DesktopResult } from '@shared/contracts'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'>

export function createServiceBusFiles(
	state: Pick<ServiceBusState, 'busy' | 'connection' | 'error' | 'fileNotice'>,
	actions: ServiceBusDependencies,
) {
	const { busy, connection, error, fileNotice } = state
	const { task } = actions
	async function fileTask<T>(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
	) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let result: T | undefined
		fileNotice.value = ''
		await task(
			label,
			(id) => action(id, connectionId),
			(value) => {
				result = value
			},
			(value) => ({
				status: (value as FileResult).cancelled ? 'cancelled' : 'completed',
				message: (value as FileResult).cancelled
					? 'File dialog cancelled.'
					: 'Local file operation completed. No messages sent or settled.',
			}),
		)
		return result
	}
	async function exportMessages(
		summaries: MessageSummary[],
		format: 'archive' | 'body' = 'archive',
		destination: 'file' | 'clipboard' = 'file',
	) {
		if (!summaries.length || summaries.some((item) => !item.snapshotId)) {
			error.value =
				'One or more bodies cannot be exported from this snapshot. Peek a smaller page or choose an inspectable message.'
			return
		}
		const result = await fileTask<FileResult>(
			destination === 'clipboard' ? 'Copy messages' : 'Save message file',
			(id, connectionId) =>
				serviceBusApi.exportMessages({
					id,
					connectionId,
					snapshotIds: summaries.map((item) => item.snapshotId!),
					format,
					destination,
				}),
		)
		if (result && !result.cancelled)
			fileNotice.value =
				destination === 'clipboard'
					? `Copied ${result.count} message(s).`
					: `Saved ${result.count} message(s) to ${result.fileName}.`
		return result
	}
	async function saveDrafts(drafts: MessageDraft[]) {
		const result = await fileTask<FileResult>('Save composer drafts', (id, connectionId) =>
			serviceBusApi.saveDrafts({
				id,
				connectionId,
				drafts: JSON.parse(JSON.stringify(drafts)),
			}),
		)
		if (result && !result.cancelled)
			fileNotice.value = `Saved ${result.count} draft(s) to ${result.fileName}.`
		return result
	}
	async function importMessages(
		format: import('@shared/message-files').ImportMessagesRequest['format'],
	) {
		return fileTask<ImportPreview>('Preview message files', (id, connectionId) =>
			serviceBusApi.importMessages({ id, connectionId, format }),
		)
	}
	async function loadImported(
		importId: string,
		entryIds: string[],
		mode: LoadImportedRequest['mode'],
		idPolicy: LoadImportedRequest['idPolicy'],
	) {
		return fileTask<ImportedDrafts>('Load selected drafts', (id, connectionId) =>
			serviceBusApi.loadImportedMessages({
				id,
				connectionId,
				importId,
				entryIds: [...entryIds],
				mode,
				idPolicy,
			}),
		)
	}
	function discardImport(importId: string) {
		if (connection.value)
			void serviceBusApi.discardImport({
				id: crypto.randomUUID(),
				connectionId: connection.value.connectionId,
				importId,
			})
	}
	return { fileTask, exportMessages, saveDrafts, importMessages, loadImported, discardImport }
}
