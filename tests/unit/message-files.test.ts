import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Backend, HostError } from '../../src/main/platform/backend'
import {
	MessageFiles,
	atomicFile,
	readBounded,
} from '../../src/main/features/service-bus/files/message-files'
import {
	ARCHIVE_FORMAT,
	emptyDraft,
	fromDraft,
	toDraft,
} from '../../src/main/features/service-bus/files/message-archive'
import {
	exportMessagesRequestSchema,
	importMessagesRequestSchema,
	type ImportPreview,
} from '../../src/shared/message-files'
import type { MessageDraft } from '../../src/shared/message-operations'
let host: Backend, files: MessageFiles, connectionId: string, directory: string
let openPaths: string[] = [],
	savePath: string | undefined
const signal = () => new AbortController().signal
const request = () => ({ id: randomUUID(), connectionId })
const target = { kind: 'queue' as const, name: 'orders' }
const peek = (name = 'orders', subQueue: 'active' | 'dead-letter' = 'active') =>
	host.request('sb.peek', {
		...request(),
		target: { kind: 'queue', name },
		subQueue,
		fromSequenceNumber: '0',
		maxMessages: 25,
	})
const archive = (messages: ReturnType<typeof fromDraft>[]) =>
	JSON.stringify({
		format: ARCHIVE_FORMAT,
		version: 1,
		exportedAtUtc: new Date().toISOString(),
		messages,
	})
const load = (preview: ImportPreview, overrides = {}) =>
	files.load(
		{
			...request(),
			importId: preview.importId!,
			entryIds: preview.items.map((item) => item.id),
			mode: 'full',
			idPolicy: 'new',
			...overrides,
		},
		signal(),
	)
async function start() {
	directory = await mkdtemp(join(tmpdir(), 'commander-files-'))
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				service: 'service-bus',
				namespace: 'fixture.servicebus.windows.net',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
	files = new MessageFiles(
		host,
		(id) => {
			if (id !== connectionId)
				throw new HostError('CONNECTION_EXPIRED', 'Connection expired.')
		},
		{ open: async () => openPaths, save: async () => savePath },
	)
	openPaths = []
	savePath = undefined
}
afterEach(async () => {
	await host?.stop()
	if (directory) await rm(directory, { recursive: true, force: true })
})
it('exports complete bodies beyond the visible preview and never receives or settles', async () => {
	await start()
	const page = await peek('large')
	savePath = join(directory, 'full-body.bin')
	await files.export(
		{ ...request(), snapshotIds: [page.items[0].snapshotId!], format: 'body' },
		signal(),
	)
	const bytes = await readFile(savePath)
	expect(bytes.length).toBe(300000)
	expect(bytes.every((value, index) => value === index % 251)).toBe(true)
	expect((await host.request('sb.deliveries', request())).items).toHaveLength(0)
	expect((await peek('large')).items[0].bodySize).toBe(300000)
})

it('copies only selected snapshots as a complete archive without a file dialog or broker mutation', async () => {
	await start()
	const page = await peek()
	let copied = ''
	const save = vi.fn(async () => undefined)
	files = new MessageFiles(host, () => {}, {
		open: async () => [],
		save,
		copy: (text) => {
			copied = text
		},
	})
	await files.export(
		{
			...request(),
			snapshotIds: [page.items[1].snapshotId!],
			format: 'archive',
			destination: 'clipboard',
		},
		signal(),
	)
	const content = JSON.parse(copied)
	expect(content.messages).toHaveLength(1)
	expect(content.messages[0].systemProperties).toContainEqual({
		name: 'MessageId',
		type: 'string',
		value: page.items[1].messageId,
	})
	expect(save).not.toHaveBeenCalled()
	expect((await peek()).items).toHaveLength(2)
	expect((await host.request('sb.deliveries', request())).items).toHaveLength(0)
})

it('keeps the clipboard unchanged when a selected archive exceeds the clipboard limit', async () => {
	const bytes = Buffer.alloc(4 * 1024 * 1024, 255)
	const fake = {
		request: vi.fn(async (method: string, input: any) =>
			method === 'sb.inspect'
				? { systemProperties: [], applicationProperties: [] }
				: {
						base64: bytes
							.subarray(input.offset, input.offset + input.count)
							.toString('base64'),
						offset: input.offset,
						totalBytes: bytes.length,
						nextOffset:
							input.offset + input.count < bytes.length
								? input.offset + input.count
								: null,
					},
		) as Backend['request'],
	}
	const copy = vi.fn()
	const local = new MessageFiles(fake, () => {}, {
		open: async () => [],
		save: async () => undefined,
		copy,
	})
	await expect(
		local.export(
			{
				id: randomUUID(),
				connectionId: randomUUID(),
				snapshotIds: [randomUUID()],
				format: 'archive',
				destination: 'clipboard',
			},
			signal(),
		),
	).rejects.toThrow('4 MiB')
	expect(copy).not.toHaveBeenCalled()
})
it('round-trips archives, exact bytes, typed values, long fractional TTLs and explicit ID policies', async () => {
	await start()
	const original: MessageDraft = {
		...emptyDraft(
			Buffer.from('{"n":9007199254740993,"city":"Málaga 🚀"}').toString('base64'),
			'application/json',
		),
		messageId: 'original',
		subject: 'copy',
		ttlDuration: '400.02:03:04.0000001',
		properties: [
			{ name: 'exact', type: 'int64', value: '9223372036854775807' },
			{ name: 'money', type: 'decimal', value: '1234567890123456789.25' },
			{ name: '__proto__', type: 'string', value: '<script>not executed</script>' },
		],
	}
	expect((await host.request('sb.send', { ...request(), target, draft: original })).status).toBe(
		'confirmed',
	)
	const page = await peek()
	savePath = join(directory, 'messages.msgc.json')
	await files.export(
		{
			...request(),
			snapshotIds: page.items.map((item) => item.snapshotId!),
			format: 'archive',
		},
		signal(),
	)
	const saved = JSON.parse(await readFile(savePath, 'utf8'))
	expect(saved.messages[0].bodyBase64).toBe(original.bodyBase64)
	expect(saved.messages[0].systemProperties).toContainEqual({
		name: 'TimeToLive',
		type: 'timespan',
		value: original.ttlDuration,
	})
	expect(JSON.stringify(saved)).not.toContain(page.items[0].snapshotId!)
	openPaths = [savePath]
	const preview = await files.import({ ...request(), format: 'archive' }, signal())
	expect(preview.items[0].fullIssue).toBeNull()
	expect(JSON.stringify(preview)).not.toContain(original.bodyBase64)
	const copied = await load(preview)
	expect(copied.drafts[0].messageId).not.toBe('original')
	const preserved = await load(preview, { idPolicy: 'preserve' })
	expect(preserved.drafts[0]).toMatchObject({
		...original,
		properties: expect.arrayContaining(original.properties),
	})
	expect(preserved.drafts[0].properties).toHaveLength(original.properties.length)
	expect((await peek()).items).toHaveLength(1) // Import has not sent anything.
	expect(
		(
			await host.request('sb.send.batch', {
				...request(),
				target,
				drafts: copied.drafts,
				scheduledEnqueueTime: null,
			})
		).status,
	).toBe('confirmed')
	expect((await peek()).items).toHaveLength(2)
})
it('saves composed drafts and imports multiple raw files without parsing their bodies', async () => {
	await start()
	const original = emptyDraft('AP9B')
	original.ttlSeconds = 60
	savePath = join(directory, 'drafts.msgc.json')
	await files.saveDrafts({ ...request(), drafts: [original] }, signal())
	expect(toDraft(JSON.parse(await readFile(savePath, 'utf8')).messages[0]).ttlDuration).toBe(
		'0.00:01:00',
	)
	const json = join(directory, 'payload.json'),
		binary = join(directory, 'payload.bin')
	await writeFile(json, '{"n":9007199254740993}')
	await writeFile(binary, Buffer.from([0, 255, 65]))
	openPaths = [json, binary]
	const preview = await files.import({ ...request(), format: 'body' }, signal())
	const { drafts } = await load(preview)
	expect(drafts.map((draft) => Buffer.from(draft.bodyBase64, 'base64'))).toEqual([
		Buffer.from('{"n":9007199254740993}'),
		Buffer.from([0, 255, 65]),
	])
	expect(drafts.map((draft) => draft.contentType)).toEqual([
		'application/json',
		'application/octet-stream',
	])
	await expect(load(preview, { idPolicy: 'preserve' })).rejects.toThrow('no original ID')
	const blankId = fromDraft(emptyDraft(''))
	blankId.systemProperties.find((property) => property.name === 'MessageId')!.value = ''
	await writeFile(savePath!, archive([blankId]))
	openPaths = [savePath!]
	const withoutId = await files.import({ ...request(), format: 'archive' }, signal())
	expect((await load(withoutId)).drafts[0].messageId).toMatch(/^[0-9a-f-]{36}$/)
	await expect(load(withoutId, { idPolicy: 'preserve' })).rejects.toThrow('no original ID')
})
it('keeps unsupported typed metadata in archives and requires explicit body-only conversion', async () => {
	await start()
	const page = await peek('orders', 'dead-letter')
	savePath = join(directory, 'dead-letter.msgc.json')
	await files.export(
		{ ...request(), snapshotIds: [page.items[0].snapshotId!], format: 'archive' },
		signal(),
	)
	const saved = JSON.parse(await readFile(savePath, 'utf8'))
	expect(saved.messages[0].applicationProperties).toContainEqual({
		name: 'binary',
		type: 'binary',
		value: 'AP8=',
	})
	expect(
		saved.messages[0].systemProperties.some(
			(p: { name: string }) => p.name === 'DeadLetterReason',
		),
	).toBe(true)
	openPaths = [savePath]
	const preview = await files.import({ ...request(), format: 'archive' }, signal())
	expect(preview.items[0].fullIssue).toContain('binary')
	await expect(load(preview)).rejects.toThrow('binary')
	const bodyOnly = await load(preview, { mode: 'body' })
	expect(bodyOnly.drafts[0].properties).toEqual([])
	expect(bodyOnly.drafts[0].bodyBase64).toBe(saved.messages[0].bodyBase64)
	expect((await peek('orders', 'dead-letter')).items).toHaveLength(1)
})
it('rejects malformed files atomically, unsupported versions and noncanonical base64', async () => {
	await start()
	const path = join(directory, 'bad.json')
	openPaths = [path]
	for (const text of [
		'{',
		'{"format":"legacy","version":1,"messages":[]}',
		archive([{ ...fromDraft(emptyDraft('')), bodyBase64: 'AB==' }]),
		archive([
			{
				...fromDraft(emptyDraft('')),
				applicationProperties: [
					{ name: 'a', type: 'string', value: 'x' },
					{ name: 'a', type: 'string', value: 'y' },
				],
			},
		]),
	]) {
		await writeFile(path, text)
		await expect(
			files.import({ ...request(), format: 'archive' }, signal()),
		).rejects.toMatchObject({ code: 'MESSAGE_FILE' })
	}
	await writeFile(path, Buffer.from([255]))
	await expect(files.import({ ...request(), format: 'archive' }, signal())).rejects.toThrow(
		'UTF-8',
	)
})
it('previews larger selections but bounds composer loads and validates property values locally', async () => {
	await start()
	const path = join(directory, 'many.json')
	openPaths = [path]
	await writeFile(path, archive(Array.from({ length: 25 }, () => fromDraft(emptyDraft('')))))
	const preview = await files.import({ ...request(), format: 'archive' }, signal())
	expect(preview.items).toHaveLength(25)
	await expect(load(preview)).rejects.toThrow('20 messages')
	expect(
		(await load(preview, { entryIds: preview.items.slice(0, 2).map((item) => item.id) }))
			.drafts,
	).toHaveLength(2)
	await writeFile(
		path,
		archive(
			Array.from({ length: 2 }, () =>
				fromDraft(emptyDraft(Buffer.alloc(220000).toString('base64'))),
			),
		),
	)
	await expect(
		load(await files.import({ ...request(), format: 'archive' }, signal())),
	).rejects.toThrow('512 KiB')
	const invalid = emptyDraft('')
	invalid.properties = [{ name: 'big', type: 'int64', value: '9223372036854775808' }]
	await writeFile(path, archive([fromDraft(invalid)]))
	await expect(
		load(await files.import({ ...request(), format: 'archive' }, signal())),
	).rejects.toThrow('invalid value')
	await expect(
		host.request('messages.validate', {
			drafts: [{ ...emptyDraft(''), ttlDuration: '00:00:00' }],
		}),
	).rejects.toThrow('positive exact TTL')
})
it('does not replace a destination on export failure or cancellation and cleans temporary files', async () => {
	await start()
	savePath = join(directory, 'keep.json')
	await writeFile(savePath, 'keep me')
	await expect(
		files.export({ ...request(), snapshotIds: [randomUUID()], format: 'archive' }, signal()),
	).rejects.toThrow('expired')
	expect(await readFile(savePath, 'utf8')).toBe('keep me')
	const controller = new AbortController()
	await expect(
		atomicFile(savePath, 100, controller.signal, async (write) => {
			await write('partial')
			controller.abort()
		}),
	).rejects.toMatchObject({ code: 'CANCELLED' })
	expect(await readFile(savePath, 'utf8')).toBe('keep me')
	await expect(atomicFile(savePath, 2, signal(), (write) => write('too large'))).rejects.toThrow(
		'limit',
	)
	expect(await readdir(directory)).toEqual(['keep.json'])
})
it('handles cancelled dialogs, read limits, stale previews and stale connection handles', async () => {
	await start()
	expect((await files.import({ ...request(), format: 'archive' }, signal())).cancelled).toBe(true)
	expect(
		(await files.saveDrafts({ ...request(), drafts: [emptyDraft('')] }, signal())).cancelled,
	).toBe(true)
	const path = join(directory, 'large.bin'),
		handle = await open(path, 'w')
	await handle.truncate(16 * 1024 * 1024 + 1)
	await handle.close()
	await expect(readBounded(path, 16 * 1024 * 1024, signal())).rejects.toThrow('16 MiB')
	await expect(readBounded(directory, 1024, signal())).rejects.toThrow('regular files')
	await writeFile(path, 'body')
	openPaths = [path]
	const preview = await files.import({ ...request(), format: 'body' }, signal())
	files.discard(connectionId, preview.importId!)
	await expect(load(preview)).rejects.toThrow('expired')
	const second = await files.import({ ...request(), format: 'body' }, signal())
	connectionId = randomUUID()
	await expect(load(second)).rejects.toThrow('expired')
	expect(
		importMessagesRequestSchema.safeParse({ ...request(), format: 'body', path }).success,
	).toBe(false)
	expect(
		exportMessagesRequestSchema.safeParse({
			...request(),
			snapshotIds: [randomUUID(), randomUUID()],
			format: 'body',
		}).success,
	).toBe(false)
})
