import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, readdir, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Backend } from '../../src/main/platform/backend'
import { EventFiles } from '../../src/main/features/event-hubs/files'
import type { EventHubsConnection } from '../../src/shared/contracts/event-hubs/core'
import { eventArchiveSchema } from '../../src/shared/contracts/event-hubs/files'
let host: Backend,
	files: EventFiles,
	connection: EventHubsConnection,
	dir: string,
	save: string | undefined,
	paths: string[]
const req = () => ({ id: randomUUID(), connectionId: connection.connectionId }),
	signal = () => new AbortController().signal
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'commander-event-files-'))
	paths = []
	save = undefined
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	connection = await host.request('eh.connect', {
		operationId: randomUUID(),
		profile: {
			id: randomUUID(),
			name: 'Events',
			service: 'event-hubs',
			namespace: 'fixture.servicebus.windows.net',
			auth: 'sas',
			tenantId: '',
			clientId: '',
			secret: 'offline',
			rememberSecret: false,
		},
		hubName: 'telemetry',
		management: null,
	})
	files = new EventFiles(
		host,
		(id) => {
			if (id !== connection.connectionId) throw new Error('Connection expired')
			return connection
		},
		{ open: async () => paths, save: async () => save },
	)
})
afterEach(async () => {
	await host?.stop()
	await rm(dir, { recursive: true, force: true })
})
async function read(hubName = 'telemetry', maxEvents = 3) {
	return host.request('eh.read', {
		...req(),
		hubName,
		consumerGroup: '$Default',
		partitionId: '0',
		position: { kind: 'earliest' },
		maxEvents,
		maxSeconds: 2,
	})
}
async function exported() {
	const result = await read()
	save = join(dir, 'events.json')
	await files.export(
		{ ...req(), format: 'archive', snapshotIds: result.items.map((i) => i.snapshotId!) },
		signal(),
	)
	paths = [save]
	return JSON.parse(await readFile(save, 'utf8'))
}
it('exports exact binary bytes, typed 64-bit values and trusted source metadata, then previews and loads without publishing', async () => {
	const archive = await exported()
	expect(eventArchiveSchema.safeParse(archive).success).toBe(true)
	expect(archive.events[1].bodyBase64).toBe('AP+AQQ==')
	expect(archive.events[0].source).toMatchObject({ hubName: 'telemetry', partitionId: '0' })
	expect(archive.events[0].sequenceNumber).toBe('9007199254740993')
	expect(archive.events[0].applicationProperties).toContainEqual({
		name: 'unsigned',
		type: 'uint64',
		value: '18446744073709551615',
	})
	expect(JSON.stringify(archive)).not.toContain('snapshotId')
	const preview = await files.import({ ...req(), format: 'archive' }, signal())
	expect(preview.items).toHaveLength(3)
	expect(JSON.stringify(preview)).not.toContain('AP+AQQ==')
	const value = await files.load(
		{
			...req(),
			importId: preview.importId!,
			entryIds: preview.items.map((i) => i.id),
			mode: 'full',
		},
		signal(),
	)
	expect(value.drafts[1].bodyBase64).toBe('AP+AQQ==')
	expect(value.drafts[0].properties).toContainEqual({
		name: 'unsigned',
		type: 'uint64',
		value: '18446744073709551615',
	})
	expect((await read()).received).toBe(3)
})
it('saves draft archives and imports raw UTF-8 and binary files with exact bodies', async () => {
	const draft = {
		bodyBase64: Buffer.from('Málaga 🚀').toString('base64'),
		contentType: 'text/plain',
		correlationId: 'trace',
		properties: [{ name: 'exact', type: 'uint64' as const, value: '18446744073709551615' }],
	}
	save = join(dir, 'drafts.json')
	await files.saveDrafts({ ...req(), drafts: [draft] }, signal())
	paths = [save]
	let preview = await files.import({ ...req(), format: 'archive' }, signal())
	let loaded = await files.load(
		{ ...req(), importId: preview.importId!, entryIds: [preview.items[0].id], mode: 'full' },
		signal(),
	)
	expect(loaded.drafts).toEqual([draft])
	const binary = join(dir, 'bytes.bin'),
		json = join(dir, 'data.json')
	await writeFile(binary, Buffer.from([0, 255, 128, 65]))
	await writeFile(json, '{"n":9007199254740993}')
	paths = [binary, json]
	preview = await files.import({ ...req(), format: 'body' }, signal())
	loaded = await files.load(
		{
			...req(),
			importId: preview.importId!,
			entryIds: preview.items.map((i) => i.id),
			mode: 'full',
		},
		signal(),
	)
	expect(loaded.drafts[0].bodyBase64).toBe('AP+AQQ==')
	expect(loaded.drafts[1].contentType).toBe('application/json')
})
it('saves all body ranges without exposing a path through IPC and cancels native dialogs without changing files', async () => {
	const result = await read('large', 1)
	expect(
		await files.export(
			{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'body' },
			signal(),
		),
	).toEqual({ cancelled: true })
	save = join(dir, 'body.bin')
	await files.export(
		{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'body' },
		signal(),
	)
	expect((await readFile(save)).length).toBe(70000)
})
it('rejects truncated metadata archives while allowing explicit body-only exports', async () => {
	const result = await read('metadata', 1)
	save = join(dir, 'existing.json')
	await writeFile(save, 'KEEP')
	await expect(
		files.export(
			{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'archive' },
			signal(),
		),
	).rejects.toThrow('truncated')
	expect(await readFile(save, 'utf8')).toBe('KEEP')
	expect((await readdir(dir)).some((p) => p.endsWith('.tmp'))).toBe(false)
	await files.export(
		{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'body' },
		signal(),
	)
	expect(await readFile(save, 'utf8')).toContain('temperature')
})
it('rejects unsupported versions, wrong service archives, malformed base64 and non-regular/oversize inputs', async () => {
	const archive = await exported()
	const path = paths[0]
	for (const value of [
		{ ...archive, version: 2 },
		{ ...archive, format: 'msg-commander/messages' },
		{ ...archive, events: [{ ...archive.events[0], bodyBase64: 'AB==' }] },
	]) {
		await writeFile(path, JSON.stringify(value))
		await expect(files.import({ ...req(), format: 'archive' }, signal())).rejects.toThrow()
	}
	paths = [dir]
	await expect(files.import({ ...req(), format: 'body' }, signal())).rejects.toThrow('regular')
	paths = [path]
	await truncate(path, 96 * 1024 * 1024 + 1)
	await expect(files.import({ ...req(), format: 'body' }, signal())).rejects.toThrow('96 MiB')
})
it('requires explicit body-only loading for unsupported properties and prevents partial oversize composer loads', async () => {
	const archive = await exported()
	archive.events[0].applicationProperties = [
		{ name: 'legacy', type: 'unsupported:custom', value: 'sample' },
	]
	await writeFile(paths[0], JSON.stringify(archive))
	const preview = await files.import({ ...req(), format: 'archive' }, signal())
	expect(preview.items[0].fullIssue).toBeTruthy()
	await expect(
		files.load(
			{
				...req(),
				importId: preview.importId!,
				entryIds: [preview.items[0].id],
				mode: 'full',
			},
			signal(),
		),
	).rejects.toThrow('properties')
	expect(
		(
			await files.load(
				{
					...req(),
					importId: preview.importId!,
					entryIds: [preview.items[0].id],
					mode: 'body',
				},
				signal(),
			)
		).drafts[0].properties,
	).toEqual([])
	const body = join(dir, 'big.bin')
	await writeFile(body, Buffer.alloc(200000))
	paths = [body, body]
	const large = await files.import({ ...req(), format: 'body' }, signal())
	await expect(
		files.load(
			{
				...req(),
				importId: large.importId!,
				entryIds: large.items.map((i) => i.id),
				mode: 'full',
			},
			signal(),
		),
	).rejects.toThrow('512 KiB')
	files.clear()
	await expect(
		files.load(
			{ ...req(), importId: large.importId!, entryIds: [large.items[0].id], mode: 'body' },
			signal(),
		),
	).rejects.toThrow('expired')
})
it('saves and reloads checkpoints with exact positions and rejects wrong target scope', async () => {
	const request = {
		...req(),
		hubName: 'telemetry',
		consumerGroup: '$Default',
		start: { kind: 'earliest' as const },
		concurrency: 2,
		maxEvents: 1,
		maxSeconds: 2,
		acknowledged: true as const,
	}
	const result = await host.request('eh.listen', request)
	save = join(dir, 'checkpoint.json')
	await files.saveCheckpoint({ ...req(), operationId: request.id }, signal())
	paths = [save]
	const loaded = await files.loadCheckpoint(
		{ ...req(), hubName: 'telemetry', consumerGroup: '$Default' },
		signal(),
	)
	expect(loaded.checkpoint).toEqual(result.checkpoint)
	await expect(
		files.loadCheckpoint({ ...req(), hubName: 'another', consumerGroup: '$Default' }, signal()),
	).rejects.toThrow('must match')
	await expect(files.import({ ...req(), format: 'archive' }, signal())).rejects.toThrow(
		'different formats',
	)
	const resumed = await host.request('eh.listen', {
		...request,
		id: randomUUID(),
		maxEvents: 2,
		start: { kind: 'checkpoint', checkpoint: loaded.checkpoint! },
	})
	expect(resumed.received).toBe(2)
	expect(resumed.items[0].sequenceNumber).toBe('9007199254740994')
})
it('does not replace existing exports when cancellation or stale body ranges interrupt saving', async () => {
	const result = await read()
	save = join(dir, 'existing.json')
	await writeFile(save, 'KEEP')
	const abort = new AbortController()
	abort.abort()
	await expect(
		files.export(
			{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'archive' },
			abort.signal,
		),
	).rejects.toThrow()
	expect(await readFile(save, 'utf8')).toBe('KEEP')
	await read()
	await expect(
		files.export(
			{ ...req(), snapshotIds: [result.items[0].snapshotId!], format: 'archive' },
			signal(),
		),
	).rejects.toThrow('expired')
	expect(await readFile(save, 'utf8')).toBe('KEEP')
})
