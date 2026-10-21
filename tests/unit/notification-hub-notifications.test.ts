import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend, HostError } from '../../src/main/platform/backend'
import { NotificationSenderController } from '../../src/main/features/notification-hubs/notifications/controller'
import {
	defaultNotification,
	notificationDraftSchema,
	notificationSendSchema,
	tagExpressionError,
} from '../../src/shared/contracts/notification-hubs/notifications'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const profile = () => ({
	id: randomUUID(),
	name: 'Send fixture',
	service: 'notification-hubs' as const,
	namespace: 'fixture.servicebus.windows.net',
	auth: 'sas' as const,
	tenantId: '',
	clientId: '',
	rememberSecret: false,
	secret: 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Send;SharedAccessKey=OFFLINE-NH-KEY;',
})
const setup = (profileId: string, hubName = 'alerts') => ({
	id: randomUUID(),
	profileId,
	hubName,
	source: 'profile' as const,
	managementConnectionId: null,
	policyTarget: null,
	keyType: null,
})
const req = () => ({ id: randomUUID(), connectionId })
const draft = () => ({ ...defaultNotification(), tagExpression: 'sports' })
async function start(hub = 'alerts') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const p = profile()
	connectionId = (
		await host.request('nh.notifications.connect', { request: setup(p.id, hub), profile: p })
	).connectionId
	return p
}
afterEach(async () => {
	await host?.stop()
	vi.restoreAllMocks()
})
it('checks production debug transport, all native formats, template strings, tag routing, results, acknowledgments and immutable workspace receipts', () => {
	expect(
		execFileSync('dotnet', [dll, '--nh-notification-checks'], { encoding: 'utf8' }),
	).toContain('checks passed')
})
it('validates tag syntax, precedence, bounds and native/template payloads before IPC', () => {
	for (const expression of [
		'sports',
		'sports && !muted',
		'(news || sports) && !muted',
		'customer:123 || tag-name',
	])
		expect(tagExpressionError(expression)).toBeUndefined()
	for (const expression of [
		'',
		'a b',
		'a | b',
		'a ||',
		'a;header',
		'a\r\n',
		'('.repeat(18) + 'a' + ')'.repeat(18),
		Array(21).fill('a').join(' || '),
		Array(11).fill('a').join(' && '),
		'a && b || c || d || e || f || g',
	])
		expect(tagExpressionError(expression)).toBeTruthy()
	for (const format of [
		'apple',
		'FcmV1',
		'windows',
		'windowsphone',
		'adm',
		'baidu',
		'template',
	] as const)
		expect(
			notificationDraftSchema.safeParse({
				...defaultNotification(format),
				target: 'broadcast',
			}).success,
		).toBe(true)
	for (const bad of [
		{ ...draft(), body: '[]' },
		{ ...draft(), body: '{"aps":42}' },
		{ ...draft(), headers: [{ name: 'Authorization', value: 'secret' }] },
		{ ...draft(), headers: [{ name: 'apns-topic', value: 'x\r\ny' }] },
		{ ...draft(), body: 'é'.repeat(33000) },
		{
			...defaultNotification('template'),
			target: 'broadcast',
			parameters: [
				{ name: 'Title', value: 'a' },
				{ name: 'title', value: 'b' },
			],
		},
		{ ...draft(), target: 'broadcast' },
	])
		expect(notificationDraftSchema.safeParse(bad).success).toBe(false)
	expect(
		notificationSendSchema.safeParse({
			...req(),
			connectionId: randomUUID(),
			draft: draft(),
			acknowledge: false,
		}).success,
	).toBe(false)
	expect(
		notificationSendSchema.safeParse({
			...req(),
			connectionId: randomUUID(),
			draft: draft(),
			acknowledge: true,
			url: 'https://evil.example',
		}).success,
	).toBe(false)
})
it('returns per-device failures, retains exact receipt and never repeats an operation', async () => {
	await start()
	const send = { ...req(), draft: draft(), acknowledge: true as const }
	const result = await host.request('nh.notifications.send', send)
	expect(result.status).toBe('confirmed')
	expect(result.details).toMatchObject({
		success: 1,
		failure: 1,
		notificationId: 'notification-123',
	})
	expect(result.details?.results.map((r) => r.outcome)).toEqual(['Success', 'InvalidToken'])
	expect(await host.request('nh.notifications.send', send)).toEqual(result)
	expect(
		await host.request('nh.notifications.result', { ...req(), operationId: send.id }),
	).toEqual(result)
	await expect(
		host.request('nh.notifications.send', {
			...send,
			draft: { ...draft(), tagExpression: 'news' },
		}),
	).rejects.toThrow('another request')
})
it('distinguishes explicit rejection, lost acknowledgment and missing detailed outcomes', async () => {
	for (const [hub, status] of [
		['send-denied', 'failed'],
		['send-uncertain', 'unknown'],
		['send-malformed', 'confirmed'],
	] as const) {
		await start(hub)
		const result = await host.request('nh.notifications.send', {
			...req(),
			draft: draft(),
			acknowledge: true,
		})
		expect(result.status).toBe(status)
		expect(result.summary).not.toContain('SECRET')
		if (hub === 'send-malformed') expect(result.details?.warning).toContain('acknowledged')
		await host.stop()
	}
})
it('cancellation after dispatch remains unknown and reset invalidates retained result access', async () => {
	await start('send-slow')
	const signal = new AbortController()
	const send = { ...req(), draft: draft(), acknowledge: true as const }
	const pending = host.request('nh.notifications.send', send, {
		signal: signal.signal,
		waitForCancellation: true,
	})
	setTimeout(() => signal.abort(), 180)
	const result = await pending
	expect(result.status).toBe('unknown')
	expect(
		await host.request('nh.notifications.result', { ...req(), operationId: send.id }),
	).toEqual(result)
	await host.request('nh.notifications.reset', {})
	await expect(host.request('nh.notifications.send', send)).rejects.toThrow('expired')
})
it('uses an explicitly selected Send policy and refuses Listen-only credentials from ARM', async () => {
	const p = await start()
	const managed = { ...p, auth: 'device-code' as const, secret: undefined }
	const admin = await host.request('nh.connect', {
		operationId: randomUUID(),
		profile: managed,
		management: {
			resourceId:
				'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture',
			tenantId: 'fixture',
			clientId: '22222222-2222-4222-8222-222222222222',
		},
	})
	const selected = {
		...setup(p.id),
		source: 'policy' as const,
		managementConnectionId: admin.connectionId,
		policyTarget: {
			scope: { kind: 'namespace' as const, name: '' as const },
			policyName: 'sender',
		},
		keyType: 'SecondaryKey' as const,
	}
	connectionId = (
		await host.request('nh.notifications.connect', { request: selected, profile: managed })
	).connectionId
	expect(
		(
			await host.request('nh.notifications.send', {
				...req(),
				draft: draft(),
				acknowledge: true,
			})
		).status,
	).toBe('confirmed')
	await expect(
		host.request('nh.notifications.connect', {
			request: {
				...selected,
				id: randomUUID(),
				policyTarget: {
					scope: { kind: 'hub', name: 'alerts' },
					policyName: 'alerts-reader',
				},
			},
			profile: managed,
		}),
	).rejects.toThrow('Send or Manage')
})
it('keeps secrets private and rejects results after main-controller reset', async () => {
	await start()
	const resolveSecret = vi.fn(() => profile()),
		forget = vi.fn()
	const controller = new NotificationSenderController(
		host,
		() => {
			throw Error('No ARM needed')
		},
		resolveSecret,
		forget,
	)
	const p = profile()
	resolveSecret.mockReturnValue(p)
	const { secret: _secret, rememberSecret: _remember, ...metadata } = p
	const connected = await controller.connect(
		setup(p.id),
		{ ...metadata, secretState: 'session' },
		new AbortController().signal,
	)
	expect(resolveSecret).toHaveBeenCalledWith(p.id)
	const receipt = await controller.send(
		{
			id: randomUUID(),
			connectionId: connected.connectionId,
			draft: draft(),
			acknowledge: true,
		},
		new AbortController().signal,
	)
	expect(receipt.status).toBe('confirmed')
	await controller.reset()
	expect(() => controller.require(connected.connectionId)).toThrow('Connect')
	expect(forget).toHaveBeenCalled()
})
it('maps lost or malformed main-process receipts to uncertain, without an automatic retry', async () => {
	const p = profile(),
		backend = { status: { state: 'ready' }, request: vi.fn() } as unknown as Backend
	const controller = new NotificationSenderController(
		backend,
		() => {
			throw Error()
		},
		() => p,
		() => {},
	)
	vi.mocked(backend.request).mockResolvedValueOnce({
		connectionId: randomUUID(),
		profileId: p.id,
		namespace: p.namespace,
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		connectedAt: new Date().toISOString(),
	})
	const connected = await controller.connect(
		setup(p.id),
		{ ...p, secretState: 'session' },
		new AbortController().signal,
	)
	vi.mocked(backend.request).mockRejectedValueOnce(
		new HostError('INVALID_REQUEST', 'Malformed output'),
	)
	await expect(
		controller.send(
			{
				id: randomUUID(),
				connectionId: connected.connectionId,
				draft: draft(),
				acknowledge: true,
			},
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
	expect(
		vi.mocked(backend.request).mock.calls.filter((c) => c[0] === 'nh.notifications.send'),
	).toHaveLength(1)
})
