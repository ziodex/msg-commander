import { beforeEach, afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Backend, HostError } from '../../src/main/platform/backend'
import { RelayFiles } from '../../src/main/features/relay/files'
import {
	relayConfigApplySchema,
	relayConfigExportSchema,
} from '../../src/shared/contracts/relay/configuration'
import {
	defaultRelaySettings,
	relayNamespace,
	type RelayScope,
} from '../../src/shared/contracts/relay/core'
let host: Backend,
	connectionId: string,
	directory: string,
	files: RelayFiles,
	path: string | undefined
const request = () => ({ id: randomUUID(), connectionId }),
	signal = () => new AbortController().signal
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Relay/namespaces/fixture'
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-relay-files-'))
	path = undefined
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	const p = {
		id: randomUUID(),
		name: 'Relay',
		service: 'relay' as const,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'device-code' as const,
		tenantId: 'fixture',
		clientId: randomUUID(),
		rememberSecret: false,
	}
	connectionId = (
		await host.request('relay.connect', {
			operationId: randomUUID(),
			profile: p,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		})
	).connectionId
	files = new RelayFiles(
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
function archive(names = ['imported-bridge']) {
	return {
		format: 'msg-commander/relay',
		version: 1,
		exportedAt: new Date().toISOString(),
		sourceNamespace: 'source.servicebus.windows.net',
		resources: names.map((name) => ({
			kind: 'hybrid',
			name,
			settings: defaultRelaySettings('hybrid'),
			policies: [{ name: 'senders', rights: ['Send'] }],
		})),
		namespacePolicies: [],
		warnings: [],
	}
}
const preview = (content: string | Buffer) =>
	host.request('relay.config.preview', {
		...request(),
		contentBase64: Buffer.from(content).toString('base64'),
	})
const decode = (value = archive()) => preview(JSON.stringify(value))
const get = (scope: RelayScope, policyName: string | null = null) =>
	host.request('relay.get', { ...request(), target: { scope, policyName } })
it('reviews Relay configuration exported under the previous product name', async () => {
	const result = await preview(
		JSON.stringify({ ...archive(), format: 'service-bus-commander/relay' }),
	)
	expect(result.entries).toHaveLength(2)
	expect(result.entries.every((entry) => !entry.issue)).toBe(true)
})
it('exports and reviews modern Relay JSON while rejecting unsupported XML', async () => {
	path = join(directory, 'relay.msgc.json')
	await files.export(
		{ ...request(), scope: { kind: 'namespace', name: '' }, format: 'json' },
		signal(),
	)
	const content = await readFile(path, 'utf8')
	expect(JSON.parse(content).format).toBe('msg-commander/relay')
	expect(JSON.parse(content).resources.length).toBeGreaterThan(0)
	expect(content).not.toMatch(/"(?:primaryKey|secondaryKey|sharedAccessKey)"\s*:/i)
	expect((await files.import(request(), signal())).preview?.entries.length).toBeGreaterThan(0)
	await expect(
		preview('<Entities xmlns="urn:unsupported:configuration"><Relays /></Entities>'),
	).rejects.toThrow('Commander Relay JSON')
})
it('reviews existing updates and rejects stale snapshots without overwriting newer settings', async () => {
	const value = await decode(archive(['bridge']))
	expect(value.entries[0]).toMatchObject({
		action: 'update',
		currentSettings: { userMetadata: 'Fixture Hybrid Connection' },
	})
	const current = await get({ kind: 'hybrid', name: 'bridge' })
	await host.request('relay.change', {
		...request(),
		target: current.target,
		action: 'update',
		expectedRevision: current.revision,
		settings: { ...current.settings!, userMetadata: 'Other administrator' },
		rights: null,
		keyType: null,
		acknowledged: true,
	})
	const result = await host.request('relay.config.apply', {
		...request(),
		importId: value.importId,
		entryIds: value.entries.map((e) => e.id),
		acknowledged: true,
	})
	expect(result.status).toBe('failed')
	expect(result.steps[1].status).toBe('not-attempted')
	expect((await get({ kind: 'hybrid', name: 'bridge' })).settings?.userMetadata).toBe(
		'Other administrator',
	)
})
it('requires acknowledgments, distinct valid selections and the new parent for policy creation', async () => {
	const value = await decode(),
		base = {
			...request(),
			importId: value.importId,
			entryIds: value.entries.map((e) => e.id),
			acknowledged: true as const,
		}
	expect(relayConfigApplySchema.safeParse({ ...base, acknowledged: false }).success).toBe(false)
	expect(
		relayConfigApplySchema.safeParse({
			...base,
			entryIds: [base.entryIds[0], base.entryIds[0]],
		}).success,
	).toBe(false)
	await expect(
		host.request('relay.config.apply', { ...base, acknowledged: false } as never),
	).rejects.toThrow('acknowledge')
	await expect(
		host.request('relay.config.apply', { ...base, entryIds: [base.entryIds[1]] }),
	).rejects.toThrow('parent')
	await expect(
		host.request('relay.config.apply', { ...base, entryIds: [randomUUID()] }),
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
	const result = await host.request('relay.config.apply', input)
	expect(result.status).toBe('unknown')
	expect(result.steps.map((s) => s.status)).toEqual([
		'unknown',
		'not-attempted',
		'not-attempted',
		'not-attempted',
	])
	expect((await get({ kind: 'hybrid', name: 'unknown-import' })).settings).toEqual(
		defaultRelaySettings('hybrid'),
	)
	await expect(get({ kind: 'hybrid', name: 'later-import' })).rejects.toThrow('no longer exists')
	expect(await host.request('relay.config.apply', input)).toEqual(result)
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
	const pending = host.request('relay.config.apply', input, {
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
	expect(
		await host.request('relay.config.result', { ...request(), operationId: input.id }),
	).toEqual(result)
	expect(events.some((e) => (e as { operationId?: string }).operationId === input.id)).toBe(true)
})
it('invalidates previews after selecting another file, disconnecting or switching connections', async () => {
	const first = await decode(),
		second = await decode(archive(['different']))
	await expect(
		host.request('relay.config.apply', {
			...request(),
			importId: first.importId,
			entryIds: [first.entries[0].id],
			acknowledged: true,
		}),
	).rejects.toThrow('expired')
	await host.request('relay.reset', {})
	await expect(
		host.request('relay.config.apply', {
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
		await files.export({ ...request(), scope: relayNamespace, format: 'json' }, signal()),
	).toEqual({ cancelled: true })
	path = join(directory, 'large.json')
	await writeFile(path, Buffer.alloc(262145))
	await expect(files.import(request(), signal())).rejects.toThrow('256 KiB')
	expect(
		relayConfigExportSchema.safeParse({
			...request(),
			scope: relayNamespace,
			format: 'json',
			path: '/tmp/untrusted',
		}).success,
	).toBe(false)
	await expect(preview(Buffer.from([0xff, 0xfe, 0xff]))).rejects.toThrow(
		'Invalid Relay configuration',
	)
})
it.each([
	'<!DOCTYPE Entities [<!ENTITY remote SYSTEM "file:///etc/passwd">]><Entities xmlns="urn:unsupported:configuration"><Relays>&remote;</Relays></Entities>',
	'<Entities xmlns="https://wrong.example"><Relays/></Entities>',
	'<Entities xmlns="urn:unsupported:configuration"><Relays><Relay><Path>a</Path><Path>b</Path></Relay></Relays></Entities>',
	JSON.stringify({ ...archive(), version: 2 }),
	JSON.stringify({ ...archive(), resources: [...archive().resources, ...archive().resources] }),
	JSON.stringify({ ...archive(['../escape']) }),
	JSON.stringify({ ...archive(), primaryKey: 'SECRET' }),
	'{"format":"x","format":"msg-commander/relay"}',
])(
	'rejects malformed, ambiguous, oversized-scope or unsafe configuration without writes: %#',
	async (content) => {
		await expect(preview(content)).rejects.toThrow('Invalid Relay configuration')
		await expect(get({ kind: 'hybrid', name: 'imported-bridge' })).rejects.toThrow(
			'no longer exists',
		)
	},
)
it('applies supported updates without rotating existing SAS keys and preserves unlisted destination policies', async () => {
	const scope: RelayScope = { kind: 'hybrid', name: 'bridge' },
		target = { scope, policyName: 'bridge-reader' }
	const before = await host.request('relay.key', { ...request(), target, keyType: 'PrimaryKey' })
	const value = archive(['bridge'])
	value.resources[0].settings.userMetadata = 'Imported update'
	value.resources[0].policies = [{ name: 'bridge-reader', rights: ['Send'] }]
	const staged = await decode(value)
	const result = await host.request('relay.config.apply', {
		...request(),
		importId: staged.importId,
		entryIds: staged.entries.map((e) => e.id),
		acknowledged: true,
	})
	expect(result.status).toBe('completed')
	expect((await get(scope)).settings?.userMetadata).toBe('Imported update')
	expect((await get(scope, 'bridge-reader')).rights).toEqual(['Send'])
	expect(
		await host.request('relay.key', { ...request(), target, keyType: 'PrimaryKey' }),
	).toEqual(before)
	expect((await get(relayNamespace, 'RootManageSharedAccessKey')).rights).toContain('Manage')
})
it('rejects more than 100 targets, nested XML and missing native settings', async () => {
	await expect(
		decode(archive(Array.from({ length: 51 }, (_, i) => 'many-' + i))),
	).rejects.toThrow('100-target')
	await expect(
		preview(
			'<Entities xmlns="urn:unsupported:configuration"><Relays>' +
				'<x>'.repeat(20) +
				'</x>'.repeat(20) +
				'</Relays></Entities>',
		),
	).rejects.toThrow('Invalid')
	const value = archive()
	delete (value.resources[0] as { settings?: unknown }).settings
	await expect(decode(value)).rejects.toThrow('Invalid')
})
it('ignores a file dialog result after its connection is replaced before saving', async () => {
	const service = new RelayFiles(
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
		service.export({ ...request(), scope: relayNamespace, format: 'json' }, signal()),
	).rejects.toThrow('expired')
	expect(await readdir(directory)).toEqual([])
})
