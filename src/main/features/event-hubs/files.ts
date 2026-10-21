import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { Backend, HostError } from '../../platform/backend'
import { atomicFile, readBounded } from '../service-bus/files/message-files'
import { decodeBody } from '../service-bus/files/message-archive'
import {
	eventArchiveSchema,
	eventFileDraftsSchema,
	type ArchiveEvent,
	type EventExport,
	type EventSaveDrafts,
	type EventImport,
	type EventImportPreview,
	type EventLoadImport,
	type EventCheckpointLoad,
} from '../../../shared/contracts/event-hubs/files'
import {
	eventCheckpointSchema,
	type EventListenResultRequest,
} from '../../../shared/contracts/event-hubs/listening'
import {
	eventDraftSchema,
	eventPropertySchema,
	type EventDraft,
} from '../../../shared/contracts/event-hubs/sending'
import type { EventHubsConnection } from '../../../shared/contracts/event-hubs/core'
import type { FileResult } from '../../../shared/message-files'
const LIMIT = 96 * 1024 * 1024
function fail(message: string): never {
	throw new HostError('EVENT_FILE', message)
}
type Format = 'archive' | 'body' | 'checkpoint'
type Candidate = {
	preview: EventImportPreview['items'][number]
	full?: EventDraft
	body?: EventDraft
}
export function eventToDraft(record: ArchiveEvent): EventDraft {
	const properties = record.applicationProperties.map((p) => {
		const type =
			(
				{
					byte: 'int32',
					sbyte: 'int32',
					int8: 'int32',
					uint8: 'int32',
					int16: 'int32',
					uint16: 'int32',
					uint32: 'int64',
					single: 'double',
					'datetime-offset': 'datetime',
					datetimeoffset: 'datetime',
				} as Record<string, string>
			)[p.type] ?? p.type
		const parsed = eventPropertySchema.safeParse({ ...p, type })
		if (!parsed.success)
			fail(
				'Some application properties cannot be represented by the composer. Choose body only explicitly, or inspect the archive.',
			)
		return parsed.data
	})
	const result = eventDraftSchema.safeParse({
		bodyBase64: record.bodyBase64,
		contentType: record.contentType ?? '',
		correlationId: record.correlationId ?? '',
		properties,
	})
	if (!result.success)
		fail(
			'Event metadata exceeds the composer limits. Choose body only explicitly or fewer/smaller events.',
		)
	return result.data
}
function fromDraft(draft: EventDraft): ArchiveEvent {
	return {
		source: null,
		sequenceNumber: null,
		offset: null,
		enqueuedTime: null,
		partitionKey: null,
		messageId: null,
		contentType: draft.contentType,
		correlationId: draft.correlationId,
		applicationProperties: draft.properties,
		systemProperties: [],
		bodyBase64: draft.bodyBase64,
	}
}
export class EventFiles {
	private staged?: { id: string; connectionId: string; entries: Candidate[] }
	constructor(
		private backend: Pick<Backend, 'request'>,
		private requireConnection: (id: string) => EventHubsConnection,
		private dialogs: {
			open(format: Format): Promise<string[]>
			save(format: Format): Promise<string | undefined>
		},
	) {}
	clear() {
		this.staged = undefined
	}
	discard(request: { connectionId: string; importId: string }) {
		this.requireConnection(request.connectionId)
		if (
			this.staged?.id === request.importId &&
			this.staged.connectionId === request.connectionId
		)
			this.clear()
		return null
	}
	private check(id: string, signal: AbortSignal) {
		signal.throwIfAborted()
		return this.requireConnection(id)
	}
	private async guard<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action()
		} catch (error) {
			if (error instanceof HostError) throw error
			if (error instanceof Error && error.name === 'AbortError')
				throw new HostError(
					'CANCELLED',
					'Event file operation cancelled. No events were published.',
				)
			fail(
				'The event file could not be read or saved. Check access, disk space, format and the 96 MiB archive / 512 KiB checkpoint limit. No events were published.',
			)
		}
	}
	async export(request: EventExport, signal: AbortSignal): Promise<FileResult> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const path = await this.dialogs.save(request.format)
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true }
			await atomicFile(path, LIMIT, signal, async (write) => {
				if (request.format === 'archive')
					await write(
						JSON.stringify({
							format: 'msg-commander/events',
							version: 1,
							exportedAt: new Date().toISOString(),
						}).slice(0, -1) + ',"events":[',
					)
				for (const [index, snapshotId] of request.snapshotIds.entries()) {
					this.check(request.connectionId, signal)
					const base = {
						id: randomUUID(),
						connectionId: request.connectionId,
						snapshotId,
					}
					if (request.format === 'archive') {
						const meta = await this.backend.request('eh.export', base, { signal })
						const d = meta.details
						if (
							d.warning ||
							[...d.applicationProperties, ...d.systemProperties].some((p) =>
								p.type.startsWith('unsupported:'),
							)
						)
							fail(
								'This event has truncated or unsupported metadata. Save its body separately; a complete archive would lose information.',
							)
						const row = {
							source: {
								namespace: meta.namespace,
								hubName: meta.hubName,
								consumerGroup: meta.consumerGroup,
								partitionId: meta.partitionId,
							},
							sequenceNumber: d.summary.sequenceNumber,
							offset: d.summary.offset,
							enqueuedTime: d.summary.enqueuedTime,
							partitionKey: d.summary.partitionKey,
							messageId: d.messageId,
							contentType: d.contentType,
							correlationId: d.correlationId,
							applicationProperties: d.applicationProperties,
							systemProperties: d.systemProperties,
						}
						await write(
							(index ? ',' : '') +
								JSON.stringify(row).slice(0, -1) +
								',"bodyBase64":"',
						)
					}
					let offset = 0,
						total: number | undefined
					do {
						this.check(request.connectionId, signal)
						const part = await this.backend.request(
							'eh.body',
							{ ...base, id: randomUUID(), offset, count: 65535 },
							{ signal },
						)
						const bytes = decodeBody(part.base64)
						total ??= part.totalBytes
						const end = offset + bytes.length
						if (
							total > 64 * 1024 * 1024 ||
							part.offset !== offset ||
							part.totalBytes !== total ||
							end > total ||
							(!bytes.length && end !== total) ||
							part.nextOffset !== (end < total ? end : null) ||
							(request.format === 'archive' && end < total && bytes.length % 3)
						)
							fail(
								'Event body ranges changed or are invalid. Export the current retained event again.',
							)
						await write(request.format === 'archive' ? part.base64 : bytes)
						offset = end
					} while (offset < total)
					if (request.format === 'archive') await write('"}')
				}
				if (request.format === 'archive') await write(']}\n')
				this.check(request.connectionId, signal)
			})
			return { cancelled: false, fileName: basename(path), count: request.snapshotIds.length }
		})
	}
	async saveDrafts(request: EventSaveDrafts, signal: AbortSignal): Promise<FileResult> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const drafts = eventFileDraftsSchema.parse(request.drafts)
			const path = await this.dialogs.save('archive')
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true }
			await atomicFile(path, LIMIT, signal, (write) =>
				write(
					JSON.stringify(
						{
							format: 'msg-commander/events',
							version: 1,
							exportedAt: new Date().toISOString(),
							events: drafts.map(fromDraft),
						},
						null,
						2,
					) + '\n',
				),
			)
			return { cancelled: false, fileName: basename(path), count: drafts.length }
		})
	}
	async import(request: EventImport, signal: AbortSignal): Promise<EventImportPreview> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			this.clear()
			const paths = await this.dialogs.open(request.format)
			this.check(request.connectionId, signal)
			if (!paths.length) return { cancelled: true, items: [] }
			if (paths.length > 1000) fail('Choose at most 1,000 files.')
			const entries: Candidate[] = []
			const append = (
				fileName: string,
				records: { record: ArchiveEvent; warnings: string[]; fullIssue: string | null }[],
			) => {
				if (entries.length + records.length > 1000)
					fail(
						'Import at most 1,000 events for preview; load up to 20 at a time into the composer.',
					)
				for (const [index, conversion] of records.entries()) {
					const record = conversion.record,
						bytes = decodeBody(record.bodyBase64)
					const preview = {
							id: randomUUID(),
							fileName,
							index: index + 1,
							bodySize: bytes.length,
							source: record.source,
							fullIssue: conversion.fullIssue,
							bodyIssue: null as string | null,
							...(conversion.warnings.length
								? { warnings: conversion.warnings }
								: {}),
						},
						entry: Candidate = { preview }
					if (bytes.length > 262144)
						preview.fullIssue = preview.bodyIssue =
							'Body exceeds the 256 KiB composer limit.'
					else {
						entry.body = {
							bodyBase64: record.bodyBase64,
							contentType:
								request.format === 'body' ? (record.contentType ?? '') : '',
							correlationId: '',
							properties: [],
						}
						if (!preview.fullIssue) {
							try {
								entry.full = eventToDraft(record)
							} catch (e) {
								preview.fullIssue =
									e instanceof Error ? e.message : 'Unsupported event properties.'
							}
						}
					}
					entries.push(entry)
				}
			}
			let remaining = LIMIT
			for (const path of paths) {
				const data = await readBounded(path, remaining, signal, '96 MiB')
				remaining -= data.length
				this.check(request.connectionId, signal)
				let records: ArchiveEvent[]
				if (request.format === 'archive') {
					const parsed = eventArchiveSchema.safeParse(
						JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
					)
					if (!parsed.success)
						fail(
							'Expected a Commander Event Hubs archive, version 1. Service Bus message archives and checkpoint files are different formats.',
						)
					records = parsed.data.events
				} else
					records = [
						fromDraft({
							bodyBase64: data.toString('base64'),
							contentType:
								extname(path) === '.json'
									? 'application/json'
									: extname(path) === '.txt'
										? 'text/plain'
										: 'application/octet-stream',
							correlationId: '',
							properties: [],
						}),
					]
				append(
					basename(path),
					records.map((record) => ({ record, warnings: [], fullIssue: null })),
				)
			}
			this.check(request.connectionId, signal)
			const importId = randomUUID()
			this.staged = { id: importId, connectionId: request.connectionId, entries }
			return { cancelled: false, importId, items: entries.map((e) => e.preview) }
		})
	}
	async load(request: EventLoadImport, signal: AbortSignal) {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const staged = this.staged
			if (
				!staged ||
				staged.id !== request.importId ||
				staged.connectionId !== request.connectionId
			)
				fail('Event import expired. Select the files again.')
			const drafts = request.entryIds.map((id) => {
				const entry = staged.entries.find((e) => e.preview.id === id)
				if (!entry) fail('Selected event is unavailable.')
				const draft = request.mode === 'full' ? entry.full : entry.body
				if (!draft)
					fail(
						request.mode === 'full'
							? entry.preview.fullIssue!
							: entry.preview.bodyIssue!,
					)
				return draft
			})
			const parsed = eventFileDraftsSchema.safeParse(drafts)
			if (!parsed.success)
				fail(
					'Select at most 20 events and 512 KiB of serialized drafts. No drafts were loaded.',
				)
			return { drafts: parsed.data }
		})
	}
	async saveCheckpoint(
		request: EventListenResultRequest,
		signal: AbortSignal,
	): Promise<FileResult> {
		return this.guard(async () => {
			this.check(request.connectionId, signal)
			const result = await this.backend.request('eh.listen.result', request, { signal })
			if (!result?.checkpoint)
				fail(
					'No final listener checkpoint is available. Recover or stop the listener first.',
				)
			const checkpoint = eventCheckpointSchema.parse(result.checkpoint)
			const path = await this.dialogs.save('checkpoint')
			this.check(request.connectionId, signal)
			if (!path) return { cancelled: true }
			await atomicFile(path, 524288, signal, (write) =>
				write(JSON.stringify(checkpoint, null, 2) + '\n'),
			)
			return {
				cancelled: false,
				fileName: basename(path),
				count: checkpoint.partitions.length,
			}
		})
	}
	async loadCheckpoint(request: EventCheckpointLoad, signal: AbortSignal) {
		return this.guard(async () => {
			const connection = this.check(request.connectionId, signal)
			const paths = await this.dialogs.open('checkpoint')
			this.check(request.connectionId, signal)
			if (!paths.length) return { cancelled: true, checkpoint: null }
			if (paths.length !== 1) fail('Select one checkpoint file.')
			const parsed = eventCheckpointSchema.safeParse(
				JSON.parse(
					new TextDecoder('utf-8', { fatal: true }).decode(
						await readBounded(paths[0], 524288, signal, '512 KiB'),
					),
				),
			)
			if (!parsed.success)
				fail('Invalid or unsupported Commander Event Hubs checkpoint file.')
			const value = parsed.data
			if (
				value.namespace.toLowerCase() !== connection.namespace.toLowerCase() ||
				value.hubName !== request.hubName ||
				value.consumerGroup !== request.consumerGroup
			)
				fail(
					'Checkpoint namespace, hub and consumer group must match the selected listener target.',
				)
			this.check(request.connectionId, signal)
			return { cancelled: false, fileName: basename(paths[0]), checkpoint: value }
		})
	}
}
