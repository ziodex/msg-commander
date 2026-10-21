import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Backend, HostError } from '../../../platform/backend'
import { type MessageDraft } from '../../../../shared/message-operations'
import {
	fileDraftsSchema,
	type ExportMessagesRequest,
	type SaveDraftsRequest,
	type ImportMessagesRequest,
	type LoadImportedRequest,
	type ImportEntry,
	type ImportPreview,
	type FileResult,
} from '../../../../shared/message-files'
import {
	ARCHIVE_FORMAT,
	IMPORT_LIMIT,
	EXPORT_LIMIT,
	archiveSchema,
	decodeBody,
	emptyDraft,
	fromDraft,
	messageId,
	toDraft,
	type ArchiveMessage,
} from './message-archive'
type Dialogs = {
	copy?: (text: string) => void
	open(format: ImportMessagesRequest['format']): Promise<string[]>
	save(format: 'archive' | 'body'): Promise<string | undefined>
}
type Candidate = { preview: ImportEntry; full?: MessageDraft; body?: MessageDraft }
function fail(message: string): never {
	throw new HostError('MESSAGE_FILE', message)
}
function check(signal: AbortSignal) {
	if (signal.aborted)
		throw new HostError(
			'CANCELLED',
			'File operation cancelled. No messages were sent or settled.',
		)
}
// The renderer never supplies filesystem paths. Native dialogs are the sole path authority.
export class MessageFiles {
	private staged?: { id: string; connectionId: string; entries: Candidate[] }
	constructor(
		private backend: Pick<Backend, 'request'>,
		private requireConnection: (id: string) => void,
		private dialogs: Dialogs,
	) {}
	clear() {
		this.staged = undefined
	}
	discard(connectionId: string, importId: string) {
		if (this.staged?.connectionId === connectionId && this.staged.id === importId) this.clear()
		return null
	}
	private check(connectionId: string, signal: AbortSignal) {
		check(signal)
		this.requireConnection(connectionId)
	}
	private async guarded<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action()
		} catch (error) {
			if (error instanceof HostError) throw error
			fail(
				'The file could not be read or saved. Check access, available disk space and the documented file format. No messages were sent or settled.',
			)
		}
	}
	async export(request: ExportMessagesRequest, signal: AbortSignal): Promise<FileResult> {
		return this.guarded(async () => {
			this.check(request.connectionId, signal)
			const copying = request.destination === 'clipboard'
			if (copying && !this.dialogs.copy) fail('Clipboard export is unavailable.')
			const destination = copying ? undefined : await this.dialogs.save(request.format)
			this.check(request.connectionId, signal)
			if (!copying && !destination) return { cancelled: true }
			const content = async (write: (value: string | Buffer) => Promise<void>) => {
				if (request.format === 'archive')
					await write(
						`{"format":${JSON.stringify(ARCHIVE_FORMAT)},"version":1,"exportedAtUtc":${JSON.stringify(new Date().toISOString())},"messages":[`,
					)
				for (const [index, snapshotId] of request.snapshotIds.entries()) {
					this.check(request.connectionId, signal)
					const base = {
						id: randomUUID(),
						connectionId: request.connectionId,
						snapshotId,
					}
					if (request.format === 'archive') {
						const details = await this.backend.request('sb.inspect', base, { signal })
						if (
							[...details.applicationProperties, ...details.systemProperties].some(
								(property) => property.type.startsWith('unsupported:'),
							)
						)
							fail(
								'This message has properties the inspector cannot represent. Save its body separately; a complete archive would lose information.',
							)
						const metadata = JSON.stringify({
							systemProperties: details.systemProperties,
							applicationProperties: details.applicationProperties,
						})
						await write(`${index ? ',' : ''}${metadata.slice(0, -1)},"bodyBase64":"`)
					}
					let offset = 0,
						total: number | undefined
					do {
						this.check(request.connectionId, signal)
						// 65535 is divisible by 3: concatenating independently encoded chunks cannot introduce interior padding.
						const chunk = await this.backend.request(
							'sb.body',
							{ ...base, id: randomUUID(), offset, count: 65535 },
							{ signal },
						)
						const bytes = decodeBody(chunk.base64)
						total ??= chunk.totalBytes
						const end = offset + bytes.length
						if (
							total > 64 * 1024 * 1024 ||
							chunk.offset !== offset ||
							chunk.totalBytes !== total ||
							end > total ||
							(bytes.length === 0 && end !== total) ||
							chunk.nextOffset !== (end < total ? end : null)
						)
							fail(
								'The message body changed or returned an invalid range. Peek again before exporting.',
							)
						if (request.format === 'archive' && end < total && bytes.length % 3)
							fail('The message body returned an invalid base64 range.')
						await write(request.format === 'body' ? bytes : chunk.base64)
						offset = end
					} while (offset < total)
					if (request.format === 'archive') await write('"}')
				}
				if (request.format === 'archive') await write(']}\n')
				this.check(request.connectionId, signal)
			}
			if (copying) {
				const chunks: Buffer[] = []
				let size = 0
				await content(async (value) => {
					const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
					size += bytes.length
					if (size > 4 * 1024 * 1024)
						fail(
							'Clipboard export exceeds 4 MiB. Select fewer messages or export a file.',
						)
					chunks.push(bytes)
				})
				this.check(request.connectionId, signal)
				this.dialogs.copy!(Buffer.concat(chunks, size).toString('utf8'))
			} else await atomicFile(destination!, EXPORT_LIMIT, signal, content)
			return {
				cancelled: false,
				...(destination ? { fileName: basename(destination) } : {}),
				count: request.snapshotIds.length,
			}
		})
	}
	async saveDrafts(request: SaveDraftsRequest, signal: AbortSignal): Promise<FileResult> {
		return this.guarded(async () => {
			this.check(request.connectionId, signal)
			await this.backend.request('messages.validate', { drafts: request.drafts }, { signal })
			const destination = await this.dialogs.save('archive')
			this.check(request.connectionId, signal)
			if (!destination) return { cancelled: true }
			const content =
				JSON.stringify(
					{
						format: ARCHIVE_FORMAT,
						version: 1,
						exportedAtUtc: new Date().toISOString(),
						messages: request.drafts.map(fromDraft),
					},
					null,
					2,
				) + '\n'
			await atomicFile(destination, EXPORT_LIMIT, signal, (write) => write(content))
			return {
				cancelled: false,
				fileName: basename(destination),
				count: request.drafts.length,
			}
		})
	}
	async import(request: ImportMessagesRequest, signal: AbortSignal): Promise<ImportPreview> {
		return this.guarded(async () => {
			this.check(request.connectionId, signal)
			this.clear()
			const paths = await this.dialogs.open(request.format)
			this.check(request.connectionId, signal)
			if (!paths.length) return { cancelled: true, items: [] }
			if (paths.length > 100) fail('Choose at most 100 files per import.')
			let remaining = IMPORT_LIMIT
			const entries: Candidate[] = []
			const append = (
				fileName: string,
				records: { record: ArchiveMessage; warnings: string[]; fullIssue: string | null }[],
			) => {
				if (entries.length + records.length > 100)
					fail(
						'Import at most 100 messages for preview. Select up to 20 at a time for the composer.',
					)
				for (const [index, conversion] of records.entries()) {
					const record = conversion.record
					let bytes: Buffer
					try {
						bytes = decodeBody(record.bodyBase64)
					} catch {
						fail('An archive body is not canonical base64. No drafts were loaded.')
					}
					const preview: ImportEntry = {
						id: randomUUID(),
						fileName,
						index: index + 1,
						messageId: request.format === 'body' ? null : messageId(record),
						bodySize: bytes.length,
						fullIssue: conversion.fullIssue,
						bodyIssue: null,
						...(conversion.warnings.length ? { warnings: conversion.warnings } : {}),
					}
					const candidate: Candidate = { preview }
					if (bytes.length > 262144)
						preview.bodyIssue = preview.fullIssue =
							'Body exceeds the composer limit of 256 KiB.'
					else {
						candidate.body = emptyDraft(record.bodyBase64)
						if (!preview.fullIssue) {
							try {
								candidate.full = toDraft(record)
							} catch (error) {
								preview.fullIssue =
									error instanceof Error
										? error.message
										: 'Unsupported message metadata.'
							}
						}
					}
					entries.push(candidate)
				}
			}
			for (const path of paths) {
				this.check(request.connectionId, signal)
				const data = await readBounded(path, remaining, signal, '16 MiB')
				remaining -= data.length
				let records: ArchiveMessage[]
				if (request.format === 'archive') {
					let decoded: unknown
					try {
						decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
					} catch {
						fail(
							'An archive is not valid UTF-8 JSON. Use Body files to import raw JSON/text/binary payloads.',
						)
					}
					const parsed = archiveSchema.safeParse(decoded)
					if (!parsed.success)
						fail(
							'Unsupported or malformed Commander message archive. Expected format msg-commander/messages, version 1, with typed properties and base64 bodies.',
						)
					records = parsed.data.messages
				} else {
					const contentType =
						extname(path).toLowerCase() === '.json'
							? 'application/json'
							: extname(path).toLowerCase() === '.txt'
								? 'text/plain'
								: 'application/octet-stream'
					records = [fromDraft(emptyDraft(data.toString('base64'), contentType))]
				}
				append(
					basename(path),
					records.map((record) => ({ record, warnings: [], fullIssue: null })),
				)
			}
			this.check(request.connectionId, signal)
			const importId = randomUUID()
			this.staged = { id: importId, connectionId: request.connectionId, entries }
			return { cancelled: false, importId, items: entries.map((entry) => entry.preview) }
		})
	}
	async load(request: LoadImportedRequest, signal: AbortSignal) {
		this.check(request.connectionId, signal)
		const staged = this.staged
		if (
			!staged ||
			staged.id !== request.importId ||
			staged.connectionId !== request.connectionId
		)
			fail('This import preview expired. Choose the files again.')
		const drafts = request.entryIds.map((id) => {
			const candidate = staged.entries.find((entry) => entry.preview.id === id)
			if (!candidate) fail('This import selection is not available.')
			const draft = request.mode === 'full' ? candidate.full : candidate.body
			if (!draft)
				fail(
					request.mode === 'full'
						? candidate.preview.fullIssue!
						: candidate.preview.bodyIssue!,
				)
			const originalId = candidate.preview.messageId
			if (request.idPolicy === 'preserve' && !originalId?.trim())
				fail('A selected message has no original ID. Choose new message IDs.')
			return { ...draft, messageId: request.idPolicy === 'new' ? randomUUID() : originalId! }
		})
		const parsed = fileDraftsSchema.safeParse(drafts)
		if (!parsed.success)
			fail(
				'Selected messages exceed the composer limits: 20 messages, 256 KiB per body and 512 KiB total serialized drafts. Select fewer messages.',
			)
		if (new Set(drafts.map((draft) => draft.messageId)).size !== drafts.length)
			fail(
				'Selected messages share message IDs. Choose new message IDs or select distinct originals.',
			)
		await this.backend.request('messages.validate', { drafts }, { signal })
		this.check(request.connectionId, signal)
		return { drafts } // Keep preview until the renderer has accepted/appended the whole set, then explicitly discard it.
	}
}
export async function readBounded(
	path: string,
	limit: number,
	signal: AbortSignal,
	limitLabel = '16 MiB',
): Promise<Buffer> {
	const file = await open(
		path,
		constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK),
	)
	try {
		const stat = await file.stat()
		if (!stat.isFile())
			fail('Choose regular files; directories and device files are not supported.')
		if (stat.size > limit)
			fail(
				`Selected files exceed the ${limitLabel} import limit. Import fewer or smaller files.`,
			)
		const chunks: Buffer[] = []
		let length = 0
		while (true) {
			check(signal)
			const buffer = Buffer.alloc(Math.min(65536, limit - length + 1))
			const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
			if (!bytesRead) break
			length += bytesRead
			if (length > limit) fail(`Selected files exceed the ${limitLabel} import limit.`)
			chunks.push(buffer.subarray(0, bytesRead))
		}
		return Buffer.concat(chunks, length)
	} finally {
		await file.close()
	}
}
export async function atomicFile(
	path: string,
	limit: number,
	signal: AbortSignal,
	produce: (write: (data: string | Buffer) => Promise<void>) => Promise<void>,
) {
	const temporary = join(dirname(path), `.msg-commander-export-${randomUUID()}.tmp`)
	const file = await open(temporary, 'wx', 0o600)
	let committed = false,
		closed = false,
		bytes = 0
	try {
		await produce(async (data) => {
			check(signal)
			bytes += Buffer.byteLength(data)
			if (bytes > limit)
				fail(
					'The export exceeds the 96 MiB file limit. Export fewer messages or save individual bodies.',
				)
			await file.writeFile(data)
		})
		check(signal)
		await file.sync()
		await file.close()
		closed = true
		check(signal)
		await rename(temporary, path)
		committed = true
	} finally {
		if (!closed) await file.close().catch(() => {})
		if (!committed) await unlink(temporary).catch(() => {})
	}
}
