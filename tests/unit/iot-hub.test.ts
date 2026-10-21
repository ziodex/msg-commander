import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseIotEndpoint, iotHubConnectSchema } from '../../src/shared/iot-hub'
import { profileInputSchema, type ProfileInput } from '../../src/shared/contracts'
import { Backend } from '../../src/main/platform/backend'
import { EventHubsController } from '../../src/main/features/event-hubs/controller'
import { WorkspaceStore } from '../../src/main/platform/workspace-store'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const secret = (hub = 'listen-many', host = 'fixture.servicebus.windows.net') =>
	`Endpoint=sb://${host}/;SharedAccessKeyName=service;SharedAccessKey=ZmFrZQ==;EntityPath=${hub}`
const profile = (hub = 'listen-many'): ProfileInput => ({
	id: randomUUID(),
	name: 'IoT telemetry',
	service: 'iot-hub',
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas',
	tenantId: '',
	clientId: '',
	secret: secret(hub),
	rememberSecret: false,
})
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
async function start(hub = 'listen-many') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const controller = new EventHubsController(host, () => {}),
		p = profile(hub)
	const result = await controller.connectIot(
		{ id: randomUUID(), profileId: p.id },
		p,
		new AbortController().signal,
	)
	connectionId = result.connectionId
	return { result, controller, p }
}
const listen = (hub = 'listen-many', maxEvents = 24) => ({
	...req(),
	hubName: hub,
	consumerGroup: 'audit',
	start: { kind: 'earliest' as const },
	concurrency: 2,
	maxEvents,
	maxSeconds: 10,
	acknowledged: true as const,
})
afterEach(async () => {
	await host?.stop()
})
it('derives only public endpoint metadata from canonical, case-insensitive and long compatible connection strings', () => {
	expect(parseIotEndpoint(secret())).toEqual({
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'listen-many',
	})
	expect(
		parseIotEndpoint(
			'  ' +
				secret().replace('Endpoint', 'endpoint').replace('sb://fixture', 'SB://FIXTURE') +
				'; ',
		),
	).toEqual({ namespace: 'fixture.servicebus.windows.net', hubName: 'listen-many' })
	expect(
		parseIotEndpoint(
			secret('iot-hub', 'iothub-ns-' + 'a'.repeat(50) + '.servicebus.windows.net'),
		).namespace.length,
	).toBeGreaterThan(50)
	expect(JSON.stringify(parseIotEndpoint(secret()))).not.toContain('ZmFrZQ')
})
it('rejects wrong endpoint schemes/scopes, device credentials, duplicate fields, unsupported SAS tokens and missing paths without echoing secrets', () => {
	for (const value of [
		'HostName=device.azure-devices.net;SharedAccessKeyName=service;SharedAccessKey=ZmFrZQ==',
		secret().replace('sb://', 'https://'),
		secret().replace('windows.net/', 'windows.net.evil/'),
		secret().replace('fixture.servicebus', 'user@fixture.servicebus'),
		secret().replace('windows.net/', 'windows.net:5671/'),
		secret().replace('EntityPath=listen-many', 'EntityPath=a/b'),
		secret().replace('EntityPath=listen-many', ''),
		secret() + ';DeviceId=device',
		secret() + ';EntityPath=other',
		secret() + ';SharedAccessSignature=secret-token',
		secret() + ';;',
		secret().replace('ZmFrZQ==', 'not-base64'),
		'\n' + secret(),
	]) {
		expect(() => parseIotEndpoint(value)).toThrow('Built-in endpoints')
		try {
			parseIotEndpoint(value)
		} catch (e) {
			expect(String(e)).not.toContain('ZmFrZQ')
		}
	}
	expect(
		iotHubConnectSchema.safeParse({
			id: randomUUID(),
			profileId: randomUUID(),
			hubName: 'other',
		}).success,
	).toBe(false)
})
it('validates IoT profiles independently of the UI and persists only public metadata for session credentials', async () => {
	const p = profile()
	expect(profileInputSchema.safeParse(p).success).toBe(true)
	expect(
		profileInputSchema.safeParse({ ...p, namespace: 'wrong.servicebus.windows.net' }).success,
	).toBe(false)
	expect(
		profileInputSchema.safeParse({
			...p,
			auth: 'device-code',
			tenantId: 'tenant',
			clientId: randomUUID(),
		}).success,
	).toBe(false)
	const dir = await mkdtemp(join(tmpdir(), 'commander-iot-profile-'))
	const protection = { available: vi.fn(() => false), encrypt: vi.fn(), decrypt: vi.fn() }
	try {
		const path = join(dir, 'workspace.json'),
			store = new WorkspaceStore(path, protection)
		await store.save(p)
		expect(store.list()[0]).toMatchObject({ service: 'iot-hub', secretState: 'session' })
		expect(JSON.stringify(store.list())).not.toContain('ZmFrZQ')
		expect(await readFile(path, 'utf8')).not.toContain('ZmFrZQ')
		expect(store.getForBackend(p.id).secret).toBe(p.secret)
		const reopened = new WorkspaceStore(path, protection)
		await reopened.load()
		expect(reopened.list()[0].service).toBe('iot-hub')
		expect(() => reopened.getForBackend(p.id)).toThrow('Re-enter')
		expect(protection.available).not.toHaveBeenCalled()
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
it('uses the production SDK connection/receiver adapter without ARM, publishing or network access', () => {
	expect(execFileSync('dotnet', [dll, '--iot-hub-checks'], { encoding: 'utf8' })).toContain(
		'IoT Hub endpoint adapter checks passed',
	)
})
it('connects using the saved EntityPath, discovers partitions and inspects device metadata and exact binary bodies', async () => {
	const { result } = await start('telemetry')
	expect(result).toMatchObject({
		service: 'iot-hub',
		access: 'read',
		managementAvailable: false,
		initialHub: { name: 'telemetry', partitionIds: ['0', '1'] },
	})
	const part = await host.request('eh.partition', {
		...req(),
		hubName: 'telemetry',
		partitionId: '0',
	})
	expect(part.beginningSequence).toBe('9007199254740993')
	const read = await host.request('eh.read', {
		...req(),
		hubName: 'telemetry',
		consumerGroup: 'audit',
		partitionId: '0',
		position: { kind: 'earliest' },
		maxEvents: 3,
		maxSeconds: 5,
	})
	const snapshotId = read.items[1].snapshotId!
	const details = await host.request('eh.inspect', { ...req(), snapshotId })
	expect(details.systemProperties).toContainEqual({
		name: 'iothub-connection-device-id',
		type: 'string',
		value: 'sensor-01',
	})
	expect(details.applicationProperties).toContainEqual({
		name: 'unsigned',
		type: 'uint64',
		value: '18446744073709551615',
	})
	expect(
		(await host.request('eh.body', { ...req(), snapshotId, offset: 0, count: 65536 })).base64,
	).toBe('AP+AQQ==')
	expect(JSON.stringify([result, details, read])).not.toContain('ZmFrZQ')
})
it('listens across all discovered partitions with bounded progress and retained inspection receipts', async () => {
	await start()
	const progress: any[] = []
	host.on('event', (e) => {
		if (e.type === 'event-hub-listen-progress') progress.push(e)
	})
	const input = listen(),
		result = await host.request('eh.listen', input, {
			timeout: 20000,
			waitForCancellation: true,
		})
	expect(result.received).toBe(24)
	expect(result.partitions.every((p) => p.received === 3)).toBe(true)
	expect(Math.max(...progress.map((e) => e.activeReceivers))).toBe(2)
	expect(progress.at(-1).activeReceivers).toBe(0)
	expect(
		(await host.request('eh.listen.result', { ...req(), operationId: input.id }))?.items,
	).toHaveLength(24)
	expect(result.checkpoint?.hubName).toBe('listen-many')
}, 20000)
it('cancels a running IoT listener with partial results and enforces a deadline for idle partitions', async () => {
	await start('listen-paced')
	const stop = new AbortController()
	host.on('event', (e) => {
		if (e.type === 'event-hub-listen-progress' && e.received >= 2) stop.abort()
	})
	const result = await host.request('eh.listen', listen('listen-paced', 100), {
		signal: stop.signal,
		waitForCancellation: true,
	})
	expect(result.status).toBe('cancelled')
	expect(result.received).toBeGreaterThanOrEqual(2)
	expect(result.received).toBeLessThan(100)
	const idle = await host.request(
		'eh.listen',
		{ ...listen('listen-paced', 100), start: { kind: 'latest' }, maxSeconds: 1 },
		{ waitForCancellation: true },
	)
	expect(idle).toMatchObject({ status: 'limited', reason: 'time', received: 0 })
})
it('rejects sends, administration, arbitrary hub changes and wrong profile types at independent boundaries', async () => {
	const { controller, p } = await start()
	const commands: [any, any][] = [
		['eh.list', { kind: 'hubs', hubName: '', continuationToken: null }],
		['eh.admin.context', {}],
		['eh.admin.change', { action: 'delete', target: { kind: 'hub', hubName: 'listen-many' } }],
		['eh.send', {}],
		['eh.hub', { hubName: 'other' }],
		['eh.partition', { hubName: 'other', partitionId: '0' }],
		['eh.listen', { ...listen(), hubName: 'other' }],
	]
	for (const [method, params] of commands)
		await expect(host.request(method, { ...req(), ...params })).rejects.toThrow(/IoT Hub/)
	await expect(
		controller.connectIot(
			{ id: randomUUID(), profileId: p.id },
			{ ...p, service: 'event-hubs' },
			new AbortController().signal,
		),
	).rejects.toThrow('IoT Hub profile')
	await expect(
		controller.connect(
			{
				id: randomUUID(),
				profileId: p.id,
				hubName: 'listen-many',
				access: 'send',
				management: null,
			},
			p,
			new AbortController().signal,
		),
	).rejects.toThrow('read-only')
	expect(controller.require(connectionId).service).toBe('iot-hub')
	for (const change of [
		{ access: 'send' },
		{ hubName: 'other' },
		{ management: { resourceId: 'invalid', tenantId: 'tenant', clientId: randomUUID() } },
	])
		await expect(
			host.request('eh.connect', {
				operationId: randomUUID(),
				profile: p,
				hubName: 'listen-many',
				management: null,
				...change,
			} as any),
		).rejects.toThrow('read-only')
})
it('sanitizes IoT access failures and rejects invalid endpoints in the host before SDK calls', async () => {
	host = new Backend('dotnet', [dll])
	await host.start()
	const connect = (p: ProfileInput) =>
		host.request('eh.connect', {
			operationId: randomUUID(),
			profile: p,
			hubName: 'denied',
			management: null,
		})
	await expect(connect(profile('denied'))).rejects.toThrow('ServiceConnect')
	await expect(
		connect({ ...profile('denied'), secret: secret('denied') + ';DeviceId=secret-device' }),
	).rejects.toThrow('Built-in endpoints')
	await expect(
		connect({ ...profile('denied'), namespace: 'wrong.servicebus.windows.net' }),
	).rejects.toThrow('hostname')
})
it('cancels connection discovery and invalidates connection IDs and retained results on disconnect', async () => {
	host = new Backend('dotnet', [dll])
	await host.start()
	const controller = new EventHubsController(host, () => {}),
		p = profile('connect-slow'),
		stop = new AbortController()
	const pending = controller.connectIot({ id: randomUUID(), profileId: p.id }, p, stop.signal)
	setTimeout(() => stop.abort(), 100)
	await expect(pending).rejects.toThrow(/cancelled/i)
	expect(() => controller.require(randomUUID())).toThrow('Connect')
	const ready = profile('telemetry'),
		connected = await controller.connectIot(
			{ id: randomUUID(), profileId: ready.id },
			ready,
			new AbortController().signal,
		)
	await controller.disconnect(connected.connectionId)
	expect(() => controller.require(connected.connectionId)).toThrow('Connect')
	await expect(
		host.request('eh.hub', {
			id: randomUUID(),
			connectionId: connected.connectionId,
			hubName: 'telemetry',
		}),
	).rejects.toThrow('expired')
})
