import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Backend, HostError } from '../../src/main/platform/backend'
import { NotificationHubRegistrationFiles } from '../../src/main/features/notification-hubs/registrations/files'
import {
	registrationFileApplySchema,
	registrationFileExportSchema,
} from '../../src/shared/contracts/notification-hubs/registration-files'
import { defaultRegistrationQuery } from '../../src/shared/contracts/notification-hubs/registrations'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend,
	connectionId: string,
	directory: string,
	path: string | undefined,
	files: NotificationHubRegistrationFiles,
	snapshots: string[]
const request = () => ({ id: randomUUID(), connectionId }),
	signal = () => new AbortController().signal
const xml =
	'<FcmV1TemplateRegistrationDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect"><Tags>news,customer:123</Tags><FcmV1RegistrationId>copy-token</FcmV1RegistrationId><BodyTemplate><![CDATA[{"message":{"data":{"body":"$(message)"}}}]]></BodyTemplate><TemplateName>copy</TemplateName><FutureProperty>&lt;script&gt;inert&lt;/script&gt;</FutureProperty></FcmV1TemplateRegistrationDescription>'
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-registration-files-'))
	path = undefined
	host = new Backend('dotnet', [dll])
	await host.start()
	const profile = {
		id: randomUUID(),
		name: 'Fixture',
		service: 'notification-hubs' as const,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'sas' as const,
		tenantId: '',
		clientId: '',
		rememberSecret: false,
		secret: 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;',
	}
	connectionId = (
		await host.request('nh.registrations.connect', {
			request: {
				id: randomUUID(),
				profileId: profile.id,
				hubName: 'alerts',
				source: 'profile',
				managementConnectionId: null,
				policyTarget: null,
				keyType: null,
			},
			profile,
		})
	).connectionId
	snapshots = (
		await host.request('nh.registrations.query', {
			...request(),
			query: defaultRegistrationQuery(),
			continuationToken: null,
		})
	).items.map((i) => i.snapshotId)
	files = new NotificationHubRegistrationFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Registration connection expired')
		},
		{ open: async () => path, save: async () => path },
	)
})
afterEach(async () => {
	await host?.stop()
	await rm(directory, { recursive: true, force: true })
	vi.restoreAllMocks()
})
it('checks production codecs, assigned IDs, immutable receipts, partial cancellation and lost acknowledgments', () => {
	expect(
		execFileSync('dotnet', [dll, '--nh-registration-files-checks'], { encoding: 'utf8' }),
	).toContain('registration file checks passed')
})
it('strictly validates named file APIs without accepting paths, raw bytes, URLs or unacknowledged writes', () => {
	const base = {
		...request(),
		importId: randomUUID(),
		entryIds: [randomUUID()],
		acknowledge: true,
	}
	expect(registrationFileApplySchema.safeParse(base).success).toBe(true)
	for (const invalid of [
		{ ...base, acknowledge: false },
		{ ...base, entryIds: [] },
		{ ...base, entryIds: [base.entryIds[0], base.entryIds[0]] },
		{ ...base, path: '/tmp/x' },
		{ ...base, contentBase64: 'AAAA' },
		{ ...base, url: 'https://evil.invalid' },
	])
		expect(registrationFileApplySchema.safeParse(invalid).success).toBe(false)
	expect(
		registrationFileExportSchema.safeParse({
			...request(),
			snapshotIds: snapshots,
			format: 'xml',
		}).success,
	).toBe(true)
	expect(
		registrationFileExportSchema.safeParse({
			...request(),
			snapshotIds: [snapshots[0], snapshots[0]],
			format: 'json',
		}).success,
	).toBe(false)
})
it.each(['json', 'xml'] as const)(
	'exports captured %s snapshots atomically with private permissions and no connection credentials',
	async (format) => {
		path = join(directory, 'registrations.' + format)
		const saved = await files.export({ ...request(), snapshotIds: snapshots, format }, signal())
		expect(saved).toMatchObject({
			cancelled: false,
			count: 2,
			fileName: 'registrations.' + format,
		})
		const content = await readFile(path, 'utf8')
		expect(content).toContain('FutureProperty')
		expect(content).toContain('apple-native')
		expect(content).not.toContain('OFFLINE-NH-KEY')
		if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
		expect(await readdir(directory)).toEqual(['registrations.' + format])
		const imported = await files.import(request(), signal())
		expect(imported.preview?.entries).toHaveLength(2)
	},
)
it('loads templates and tags, privately inspects definitions, and creates new IDs after explicit acknowledgment', async () => {
	path = join(directory, 'copy.xml')
	await writeFile(path, xml)
	const value = await files.import(request(), signal()),
		preview = value.preview!
	expect(value.fileName).toBe('copy.xml')
	expect(preview.entries[0]).toMatchObject({
		template: true,
		tags: ['news', 'customer:123'],
		action: 'create',
	})
	const inspected = await host.request('nh.registrations.files.inspect', {
		...request(),
		importId: preview.importId,
		entryId: preview.entries[0].id,
	})
	expect(inspected.rawXml).toContain('FutureProperty')
	const result = await host.request('nh.registrations.files.apply', {
		...request(),
		importId: preview.importId,
		entryIds: [preview.entries[0].id],
		acknowledge: true,
	})
	expect(result).toMatchObject({
		status: 'completed',
		steps: [{ status: 'confirmed', receipt: { registrationId: 'created-1' } }],
	})
	const details = await host.request('nh.registrations.get', {
		...request(),
		snapshotId: result.steps[0].receipt!.snapshotId!,
	})
	expect(details.templateBody).toContain('$(message)')
	expect(details.registration.tags).toEqual(['news', 'customer:123'])
})
it('cancels either picker before requesting backend file operations', async () => {
	const spy = vi.spyOn(host, 'request')
	expect(await files.import(request(), signal())).toEqual({ cancelled: true, preview: null })
	expect(
		await files.export({ ...request(), snapshotIds: snapshots, format: 'json' }, signal()),
	).toEqual({ cancelled: true })
	expect(spy).not.toHaveBeenCalled()
})
it('discards a stale or cancelled native picker before file access', async () => {
	path = join(directory, 'missing-SECRET.xml')
	const stale = new NotificationHubRegistrationFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Expired')
		},
		{
			open: async () => {
				connectionId = randomUUID()
				return path
			},
			save: async () => path,
		},
	)
	await expect(stale.import(request(), signal())).rejects.toMatchObject({ code: 'STALE' })
	const abort = new AbortController(),
		cancelled = new NotificationHubRegistrationFiles(host, () => {}, {
			open: async () => {
				abort.abort()
				return path
			},
			save: async () => undefined,
		})
	await expect(cancelled.import(request(), abort.signal)).rejects.toMatchObject({
		code: 'CANCELLED',
	})
})
it.each(['oversize', 'directory', 'invalid'] as const)(
	'rejects %s input and keeps local paths or contents out of errors',
	async (kind) => {
		path = join(directory, 'SECRET-file.xml')
		if (kind === 'oversize') await writeFile(path, Buffer.alloc(524289))
		if (kind === 'directory') path = directory
		if (kind === 'invalid') await writeFile(path, '<invalid>SECRET-file-content')
		const error = await files.import(request(), signal()).catch((e) => e)
		expect(error).toBeInstanceOf(HostError)
		expect(error.message).not.toContain('SECRET')
		expect(error.message).not.toContain(directory)
	},
)
it('does not replace an existing file when a backend snapshot expired', async () => {
	path = join(directory, 'existing.json')
	await writeFile(path, 'preserve me')
	await expect(
		files.export({ ...request(), snapshotIds: [randomUUID()], format: 'json' }, signal()),
	).rejects.toThrow('expired')
	expect(await readFile(path, 'utf8')).toBe('preserve me')
	expect(await readdir(directory)).toEqual(['existing.json'])
})
it('rejects malformed or oversized encoded exports without replacing a file', async () => {
	path = join(directory, 'existing.json')
	await writeFile(path, 'preserve me')
	for (const contentBase64 of ['not base64', Buffer.alloc(524289).toString('base64')]) {
		const invalid = new NotificationHubRegistrationFiles(
			{ request: vi.fn().mockResolvedValue({ contentBase64, count: 1 }) },
			() => {},
			{ open: async () => path, save: async () => path },
		)
		await expect(
			invalid.export({ ...request(), snapshotIds: snapshots, format: 'json' }, signal()),
		).rejects.toMatchObject({ code: 'NH_REGISTRATION_FILE' })
		expect(await readFile(path, 'utf8')).toBe('preserve me')
	}
})
it('drops a late preview when registration authority changes during decode', async () => {
	path = join(directory, 'copy.xml')
	await writeFile(path, xml)
	const original = host.request.bind(host)
	vi.spyOn(host, 'request').mockImplementation(async (method, value, options) => {
		const result = await original(method, value as never, options)
		connectionId = randomUUID()
		return result as never
	})
	await expect(files.import(request(), signal())).rejects.toMatchObject({ code: 'STALE' })
})
