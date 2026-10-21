import { beforeEach, afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Backend, HostError } from '../../src/main/platform/backend'
import { NotificationHubFiles } from '../../src/main/features/notification-hubs/configuration/files'
import {
	nhConfigApplySchema,
	nhConfigExportSchema,
} from '../../src/shared/contracts/notification-hubs/configuration'
import {
	nhNamespace,
	type NotificationHubScope,
} from '../../src/shared/contracts/notification-hubs/core'
let host: Backend,
	connectionId: string,
	directory: string,
	files: NotificationHubFiles,
	path: string | undefined
const request = () => ({ id: randomUUID(), connectionId }),
	signal = () => new AbortController().signal
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-notification-hub-files-'))
	path = undefined
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	const p = {
		id: randomUUID(),
		name: 'Notification Hubs',
		service: 'notification-hubs' as const,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'device-code' as const,
		tenantId: 'fixture',
		clientId: randomUUID(),
		rememberSecret: false,
	}
	connectionId = (
		await host.request('nh.connect', {
			operationId: randomUUID(),
			profile: p,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		})
	).connectionId
	files = new NotificationHubFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Connection expired')
		},
		{ open: async () => path, save: async () => path },
	)
})
afterEach(async () => {
	await host?.stop()
	await rm(directory, { recursive: true, force: true })
})
it('exports and reviews modern Notification Hubs JSON while rejecting unsupported XML', async () => {
	path = join(directory, 'notification-hubs.msgc.json')
	await files.export({ ...request(), scope: nhNamespace, format: 'json' }, signal())
	const content = await readFile(path, 'utf8')
	expect(JSON.parse(content).format).toBe('msg-commander/notification-hubs')
	expect(JSON.parse(content).resources.length).toBeGreaterThan(0)
	expect(content).not.toMatch(/"(?:primaryKey|secondaryKey|sharedAccessKey)"\s*:/i)
	expect((await files.import(request(), signal())).preview?.entries.length).toBeGreaterThan(0)
	await expect(
		preview('<Entities xmlns="urn:unsupported:configuration"><NotificationHubs /></Entities>'),
	).rejects.toThrow('Commander JSON')
})
function archive(names = ['imported-bridge']) {
	return {
		format: 'msg-commander/notification-hubs',
		version: 1,
		exportedAt: new Date().toISOString(),
		sourceNamespace: 'source.servicebus.windows.net',
		resources: names.map((name) => ({
			name,
			replaceTags: true,
			settings: { registrationTtl: '30.00:00:00', tags: [] },
			policies: [{ name: 'senders', rights: ['Send'] }],
		})),
		namespacePolicies: [],
		warnings: [],
	}
}
const preview = (content: string | Buffer) =>
	host.request('nh.config.preview', {
		...request(),
		contentBase64: Buffer.from(content).toString('base64'),
	})
const decode = (value = archive()) => preview(JSON.stringify(value))
const get = (scope: NotificationHubScope, policyName: string | null = null) =>
	host.request('nh.get', { ...request(), target: { scope, policyName } })
it('requires acknowledgments, distinct valid selections and the new parent for policy creation', async () => {
	const value = await decode(),
		base = {
			...request(),
			importId: value.importId,
			entryIds: value.entries.map((e) => e.id),
			acknowledged: true as const,
		}
	expect(nhConfigApplySchema.safeParse({ ...base, acknowledged: false }).success).toBe(false)
	expect(
		nhConfigApplySchema.safeParse({ ...base, entryIds: [base.entryIds[0], base.entryIds[0]] })
			.success,
	).toBe(false)
	await expect(
		host.request('nh.config.apply', { ...base, acknowledged: false } as never),
	).rejects.toThrow('acknowledge')
	await expect(
		host.request('nh.config.apply', { ...base, entryIds: [base.entryIds[1]] }),
	).rejects.toThrow('parent')
	await expect(
		host.request('nh.config.apply', { ...base, entryIds: [randomUUID()] }),
	).rejects.toThrow('blocked')
})
it('keeps unknown accepted writes recoverable and stops later resource/policy writes', async () => {
	const value = await decode(archive(['unknown-import', 'later-import'])),
		input = {
			...request(),
			importId: value.importId,
			entryIds: value.entries.map((e) => e.id),
			acknowledged: true as const,
		}
	const result = await host.request('nh.config.apply', input)
	expect(result.status).toBe('unknown')
	expect(result.steps.map((s) => s.status)).toEqual([
		'unknown',
		'not-attempted',
		'not-attempted',
		'not-attempted',
	])
	expect((await get({ kind: 'hub', name: 'unknown-import' })).settings).toEqual({
		registrationTtl: '30.00:00:00',
		tags: [],
	})
	await expect(get({ kind: 'hub', name: 'later-import' })).rejects.toThrow('no longer exists')
	expect(await host.request('nh.config.apply', input)).toEqual(result)
	expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('keeps confirmed earlier changes and progress when cancellation interrupts a later write', async () => {
	const value = await decode(archive(['completed-before-cancel', 'write-slow-import'])),
		abort = new AbortController(),
		events: unknown[] = []
	host.on('event', (event) => events.push(event))
	const input = {
		...request(),
		importId: value.importId,
		entryIds: value.entries.map((e) => e.id),
		acknowledged: true as const,
	}
	const pending = host.request('nh.config.apply', input, {
		signal: abort.signal,
		waitForCancellation: true,
	})
	setTimeout(() => abort.abort(), 250)
	const result = await pending
	expect(result.status).toBe('unknown')
	expect(result.steps.map((s) => s.status)).toEqual([
		'confirmed',
		'confirmed',
		'unknown',
		'not-attempted',
	])
	expect(await host.request('nh.config.result', { ...request(), operationId: input.id })).toEqual(
		result,
	)
	expect(events.some((e) => (e as { operationId?: string }).operationId === input.id)).toBe(true)
})
it('invalidates previews after selecting another file, disconnecting or switching connections', async () => {
	const first = await decode(),
		second = await decode(archive(['different']))
	await expect(
		host.request('nh.config.apply', {
			...request(),
			importId: first.importId,
			entryIds: [first.entries[0].id],
			acknowledged: true,
		}),
	).rejects.toThrow('expired')
	await host.request('nh.reset', {})
	await expect(
		host.request('nh.config.apply', {
			...request(),
			importId: second.importId,
			entryIds: [second.entries[0].id],
			acknowledged: true,
		}),
	).rejects.toThrow('expired')
})
it('handles native dialog cancellation, file limits, malformed encodings and renderer path injection', async () => {
	expect(await files.import(request(), signal())).toEqual({ cancelled: true, preview: null })
	expect(
		await files.export({ ...request(), scope: nhNamespace, format: 'json' }, signal()),
	).toEqual({ cancelled: true })
	path = join(directory, 'large.json')
	await writeFile(path, Buffer.alloc(262145))
	await expect(files.import(request(), signal())).rejects.toThrow('256 KiB')
	expect(
		nhConfigExportSchema.safeParse({
			...request(),
			scope: nhNamespace,
			format: 'json',
			path: '/tmp/untrusted',
		}).success,
	).toBe(false)
	await expect(preview(Buffer.from([0xff, 0xfe, 0xff]))).rejects.toThrow(
		'Invalid Notification Hubs configuration',
	)
})
it.each([
	'<!DOCTYPE Entities [<!ENTITY remote SYSTEM "file:///etc/passwd">]><Entities xmlns="urn:unsupported:configuration"><NotificationHubs>&remote;</NotificationHubs></Entities>',
	'<Entities xmlns="https://wrong.example"><NotificationHubs/></Entities>',
	'<Entities xmlns="urn:unsupported:configuration"><NotificationHubs><NotificationHub><Path>a</Path><Path>b</Path></NotificationHub></NotificationHubs></Entities>',
	JSON.stringify({ ...archive(), version: 2 }),
	JSON.stringify({ ...archive(), resources: [...archive().resources, ...archive().resources] }),
	JSON.stringify({ ...archive(['../escape']) }),
	JSON.stringify({ ...archive(), primaryKey: 'SECRET' }),
	'{"format":"x","format":"msg-commander/notification-hubs"}',
])(
	'rejects malformed, ambiguous, oversized-scope or unsafe configuration without writes: %#',
	async (content) => {
		await expect(preview(content)).rejects.toThrow('Invalid Notification Hubs configuration')
		await expect(get({ kind: 'hub', name: 'imported-bridge' })).rejects.toThrow(
			'no longer exists',
		)
	},
)
it('rejects more than 100 targets, nested XML and missing native settings', async () => {
	await expect(
		decode(archive(Array.from({ length: 51 }, (_, i) => 'many-' + i))),
	).rejects.toThrow('100-target')
	await expect(
		preview(
			'<Entities xmlns="urn:unsupported:configuration"><NotificationHubs>' +
				'<x>'.repeat(20) +
				'</x>'.repeat(20) +
				'</NotificationHubs></Entities>',
		),
	).rejects.toThrow('Invalid')
	const value = archive()
	delete (value.resources[0] as { settings?: unknown }).settings
	await expect(decode(value)).rejects.toThrow('Invalid')
})
it('ignores a file dialog result after its connection is replaced before saving', async () => {
	const service = new NotificationHubFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Connection expired')
		},
		{
			open: async () => undefined,
			save: async () => {
				connectionId = randomUUID()
				return join(directory, 'late.json')
			},
		},
	)
	await expect(
		service.export({ ...request(), scope: nhNamespace, format: 'json' }, signal()),
	).rejects.toThrow('expired')
	expect(await readdir(directory)).toEqual([])
})
it('rejects stale preview updates and leaves later targets unattempted', async () => {
	const value = await decode(archive(['alerts', 'later-import']))
	const current = await get({ kind: 'hub', name: 'alerts' })
	await host.request('nh.change', {
		...request(),
		target: current.target,
		action: 'update',
		expectedRevision: current.revision,
		settings: { ...current.settings!, registrationTtl: '40.00:00:00' },
		rights: null,
		keyType: null,
		acknowledged: true,
	})
	const result = await host.request('nh.config.apply', {
		...request(),
		importId: value.importId,
		entryIds: value.entries.map((e) => e.id),
		acknowledged: true,
	})
	expect(result.status).toBe('failed')
	expect(result.steps.slice(1).every((s) => s.status === 'not-attempted')).toBe(true)
	expect((await get(current.target.scope)).settings?.registrationTtl).toBe('40.00:00:00')
})
it('updates policy rights without changing keys and keeps unlisted destination policies', async () => {
	const scope: NotificationHubScope = { kind: 'hub', name: 'alerts' },
		target = { scope, policyName: 'alerts-reader' }
	const before = await host.request('nh.key', { ...request(), target, keyType: 'PrimaryKey' })
	const value = archive(['alerts'])
	value.resources[0].policies = [{ name: 'alerts-reader', rights: ['Send'] }]
	const staged = await decode(value)
	expect(staged.entries[0].action).toBe('update')
	const result = await host.request('nh.config.apply', {
		...request(),
		importId: staged.importId,
		entryIds: staged.entries.map((e) => e.id),
		acknowledged: true,
	})
	expect(result.status).toBe('completed')
	expect((await get(scope, 'alerts-reader')).rights).toEqual(['Send'])
	expect(await host.request('nh.key', { ...request(), target, keyType: 'PrimaryKey' })).toEqual(
		before,
	)
	expect((await get(nhNamespace, 'RootManageSharedAccessKey')).rights).toContain('Manage')
})
it('preserves existing files when Azure export fails and leaves no temporary files', async () => {
	path = join(directory, 'existing.json')
	await writeFile(path, 'unchanged')
	await expect(
		files.export(
			{ ...request(), scope: { kind: 'hub', name: 'missing' }, format: 'json' },
			signal(),
		),
	).rejects.toThrow()
	expect(await readFile(path, 'utf8')).toBe('unchanged')
	expect(await readdir(directory)).toEqual(['existing.json'])
})
it('blocks namespace root policy privilege removal and redacts untrusted warnings', async () => {
	const value = archive()
	value.namespacePolicies = [{ name: 'rootmanagesharedaccesskey', rights: ['Send'] }] as never
	value.warnings = ['SECRET-FILE-WARNING'] as never
	const staged = await decode(value)
	expect(staged.entries.at(-1)?.action).toBe('blocked')
	expect(JSON.stringify(staged)).not.toContain('SECRET')
})

it('validates production ARM preservation, deadlines, cancellation and receipt boundaries offline', async () => {
	const result = await promisify(execFile)('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
		'--nh-config-checks',
	])
	expect(result.stdout).toContain('Notification Hubs configuration checks passed')
})
