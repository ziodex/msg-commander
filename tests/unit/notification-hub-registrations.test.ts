import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { NotificationHubRegistrationsController } from '../../src/main/features/notification-hubs/registrations/controller'
import {
	defaultRegistrationQuery,
	nhRegistrationQuerySchema,
	nhRegistrationsConnectSchema,
	type NotificationHubRegistrationsConnect,
} from '../../src/shared/contracts/notification-hubs/registrations'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const profile = () => ({
	id: randomUUID(),
	name: 'Registration fixture',
	service: 'notification-hubs' as const,
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas' as const,
	tenantId: '',
	clientId: '',
	rememberSecret: false,
	secret: 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;',
})
const setup = (profileId: string): NotificationHubRegistrationsConnect => ({
	id: randomUUID(),
	profileId,
	hubName: 'alerts',
	source: 'profile',
	managementConnectionId: null,
	policyTarget: null,
	keyType: null,
})
const req = () => ({ id: randomUUID(), connectionId })
const query = (
	value = defaultRegistrationQuery(),
	continuationToken: string | null = null,
	signal?: AbortSignal,
) =>
	host.request(
		'nh.registrations.query',
		{ ...req(), query: value, continuationToken },
		{ signal },
	)
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	const p = profile()
	connectionId = (
		await host.request('nh.registrations.connect', { request: setup(p.id), profile: p })
	).connectionId
	return p
}
afterEach(async () => {
	await host?.stop()
	vi.restoreAllMocks()
})
it('checks production REST/SAS transport, platforms, XML bounds and query encoding', () => {
	expect(
		execFileSync('dotnet', [dll, '--nh-registrations-checks'], { encoding: 'utf8' }),
	).toContain('registration adapter checks passed')
})
it('validates exclusive credential sources, scoped policies, tags, device handles and page limits', () => {
	const value = setup(randomUUID())
	expect(nhRegistrationsConnectSchema.safeParse(value).success).toBe(true)
	expect(nhRegistrationsConnectSchema.safeParse({ ...value, source: 'policy' }).success).toBe(
		false,
	)
	expect(
		nhRegistrationsConnectSchema.safeParse({
			...value,
			policyTarget: { scope: { kind: 'namespace', name: '' }, policyName: 'Manage' },
		}).success,
	).toBe(false)
	expect(
		nhRegistrationsConnectSchema.safeParse({
			...value,
			source: 'policy',
			managementConnectionId: randomUUID(),
			keyType: 'PrimaryKey',
			policyTarget: { scope: { kind: 'hub', name: 'other' }, policyName: 'Manage' },
		}).success,
	).toBe(false)
	const all = defaultRegistrationQuery()
	for (const bad of [
		{ ...all, pageSize: 0 },
		{ ...all, pageSize: 101 },
		{ ...all, value: 'extra' },
		{ ...all, mode: 'tag', value: 'a && b' },
		{ ...all, mode: 'tag', value: '..' },
		{ ...all, mode: 'handle', value: '\nSECRET' },
		{ ...all, mode: 'handle', handleKind: 'apns', value: 'not-hex' },
		{ ...all, mode: 'handle', handleKind: 'wns', value: 'https://user:password@evil.invalid/' },
		{ ...all, mode: 'handle', handleKind: 'fcm', value: 'with spaces' },
	])
		expect(nhRegistrationQuerySchema.safeParse(bad).success).toBe(false)
	expect(
		nhRegistrationQuerySchema.safeParse({ ...all, mode: 'handle', value: "token'&x=y" })
			.success,
	).toBe(true)
	expect(
		nhRegistrationQuerySchema.safeParse({ ...all, mode: 'tag', value: 'customer:123' }).success,
	).toBe(true)
})
it('pages without skips/repeats, inspects captured templates and keeps raw tokens out of the renderer contract', async () => {
	await start()
	const first = await query()
	expect(first.items.map((i) => i.registrationId)).toEqual(['apple-native', 'fcm-template'])
	expect(first.continuationToken).toMatch(/^[0-9a-f-]{36}$/)
	expect(JSON.stringify(first)).not.toContain('opaque')
	const details = await host.request('nh.registrations.inspect', {
		...req(),
		snapshotId: first.items[1].snapshotId,
	})
	expect(details.templateBody).toContain('$(title)')
	expect(details.rawXml).toContain('FutureProperty')
	expect(details.etag).toBe('W/"42"')
	expect(details.capturedAt).toBe(first.capturedAt)
	const second = await query(defaultRegistrationQuery(), first.continuationToken)
	expect(second.items[0].registrationId).toBe('windows-native')
	const previous = await query()
	expect(previous.items.map((i) => i.registrationId)).toEqual(
		first.items.map((i) => i.registrationId),
	)
	await expect(query(defaultRegistrationQuery(), first.continuationToken)).rejects.toThrow(
		'cursor',
	)
})
it('binds cursors to mode, value, format and page size, clears handles on reconnect', async () => {
	const p = await start()
	const first = await query()
	for (const selected of [
		{ ...defaultRegistrationQuery(), pageSize: 10 },
		{ ...defaultRegistrationQuery(), mode: 'tag' as const, value: 'news' },
		{
			...defaultRegistrationQuery(),
			mode: 'handle' as const,
			value: 'token',
			handleKind: 'fcm' as const,
		},
	])
		await expect(query(selected, first.continuationToken)).rejects.toThrow('cursor')
	const old = connectionId
	connectionId = (
		await host.request('nh.registrations.connect', { request: setup(p.id), profile: p })
	).connectionId
	await expect(
		host.request('nh.registrations.inspect', {
			id: randomUUID(),
			connectionId: old,
			snapshotId: first.items[0].snapshotId,
		}),
	).rejects.toThrow('expired')
	await expect(query(defaultRegistrationQuery(), first.continuationToken)).rejects.toThrow(
		'cursor',
	)
})
it('queries exact tags and quoted handles and reports empty results', async () => {
	await start()
	const base = defaultRegistrationQuery()
	expect(
		(await query({ ...base, mode: 'tag', value: 'news' })).items.map((i) => i.registrationId),
	).toEqual(['fcm-template', 'windows-native'])
	expect(
		(await query({ ...base, mode: 'handle', value: "fcm-token-'quoted'&value=one" })).items[0]
			.registrationId,
	).toBe('fcm-template')
	expect((await query({ ...base, mode: 'tag', value: 'empty' })).items).toEqual([])
})
it('retains a failed next-page cursor for explicit retry and cancels queries without losing inspection', async () => {
	await start()
	const selected = { ...defaultRegistrationQuery(), mode: 'tag' as const, value: 'flaky' }
	const first = await query(selected)
	await expect(query(selected, first.continuationToken)).rejects.toThrow('Nothing was retried')
	expect((await query(selected, first.continuationToken)).items[0].registrationId).toBe(
		'windows-native',
	)
	const cancel = new AbortController()
	const pending = query(
		{ ...defaultRegistrationQuery(), mode: 'tag', value: 'slow' },
		null,
		cancel.signal,
	)
	setTimeout(() => cancel.abort(), 100)
	await expect(pending).rejects.toThrow('cancelled')
	const details = await host.request('nh.registrations.inspect', {
		...req(),
		snapshotId: first.items[0].snapshotId,
	})
	expect(details.registration.registrationId).toBe('apple-native')
})
it('uses only an explicitly selected Manage policy and expires policy data access with the ARM connection', async () => {
	const p = await start()
	const admin = await host.request('nh.connect', {
		operationId: randomUUID(),
		profile: { ...p, auth: 'device-code', secret: undefined },
		management: {
			resourceId:
				'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture',
			tenantId: 'fixture',
			clientId: randomUUID(),
		},
	})
	const selected = {
		...setup(p.id),
		source: 'policy' as const,
		managementConnectionId: admin.connectionId,
		keyType: 'SecondaryKey' as const,
		policyTarget: {
			scope: { kind: 'hub' as const, name: 'alerts' },
			policyName: 'alerts-reader',
		},
	}
	await expect(
		host.request('nh.registrations.connect', {
			request: selected,
			profile: { ...p, secret: undefined },
		}),
	).rejects.toThrow('Manage')
	selected.id = randomUUID()
	selected.policyTarget = {
		scope: { kind: 'namespace', name: '' } as never,
		policyName: 'RootManageSharedAccessKey',
	}
	const data = await host.request('nh.registrations.connect', {
		request: selected,
		profile: { ...p, secret: undefined },
	})
	connectionId = data.connectionId
	expect(JSON.stringify(data)).not.toMatch(/OFFLINE|SharedAccessKey|ConnectionString/)
	expect((await query()).items.length).toBe(2)
	await host.request('nh.reset', {})
	await expect(query()).rejects.toThrow('management connection expired')
})
it('does not unlock data credentials when connecting through an explicitly selected management policy', async () => {
	const p = await start()
	const admin = {
		connectionId: randomUUID(),
		profileId: p.id,
		namespace: p.namespace,
		resourceId: 'fixture',
		connectedAt: new Date().toISOString(),
		location: 'fixture',
	}
	const secret = vi.fn(() => p),
		request = vi.spyOn(host, 'request')
	const c = new NotificationHubRegistrationsController(
		host,
		() => admin,
		secret,
		() => {},
	)
	request.mockResolvedValueOnce({
		connectionId: randomUUID(),
		profileId: p.id,
		namespace: p.namespace,
		hubName: 'alerts',
		source: 'policy',
		managementConnectionId: admin.connectionId,
		connectedAt: new Date().toISOString(),
	} as never)
	const { secret: _secret, rememberSecret: _remember, ...publicProfile } = p
	await c.connect(
		{
			...setup(p.id),
			source: 'policy',
			managementConnectionId: admin.connectionId,
			policyTarget: {
				scope: { kind: 'namespace', name: '' },
				policyName: 'RootManageSharedAccessKey',
			},
			keyType: 'PrimaryKey',
		},
		{ ...publicProfile, secretState: 'locked' },
		new AbortController().signal,
	)
	expect(secret).not.toHaveBeenCalled()
	expect(JSON.stringify(request.mock.calls.at(-1)?.[1])).not.toContain('OFFLINE-NH-KEY')
})
it('rejects main-process stale query results and lazily unlocks a SAS credential only on explicit connect', async () => {
	const p = await start(),
		secret = vi.fn(() => p),
		reset = vi.fn()
	const c = new NotificationHubRegistrationsController(
		host,
		() => {
			throw new Error('Unexpected ARM access')
		},
		secret,
		reset,
	)
	const { secret: _secret, rememberSecret: _remember, ...publicProfile } = p
	const active = await c.connect(
		setup(p.id),
		{ ...publicProfile, secretState: 'session' },
		new AbortController().signal,
	)
	expect(secret).toHaveBeenCalledOnce()
	const original = host.request.bind(host)
	let finish!: () => void
	vi.spyOn(host, 'request').mockImplementation(async (method, input, options) => {
		const result = await original(method, input as never, options)
		if (method === 'nh.registrations.query')
			await new Promise<void>((resolve) => {
				finish = resolve
			})
		return result as never
	})
	const pending = c.query(
		{
			...req(),
			connectionId: active.connectionId,
			query: defaultRegistrationQuery(),
			continuationToken: null,
		},
		new AbortController().signal,
	)
	await vi.waitFor(() => expect(finish).toBeDefined())
	c.forget()
	finish()
	await expect(pending).rejects.toThrow('cancelled')
	expect(reset).toHaveBeenCalledOnce()
})
