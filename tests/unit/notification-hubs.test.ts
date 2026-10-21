import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { NotificationHubsController } from '../../src/main/features/notification-hubs/controller'
import {
	defaultNotificationHubSettings,
	nhChangeSchema,
	nhConnectSchema,
	nhNameSchema,
	nhSettingsSchema,
	nhPolicyNameSchema,
	type NotificationHubChange,
	type NotificationHubTarget,
} from '../../src/shared/contracts/notification-hubs/core'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
const profile = () => ({
	id: randomUUID(),
	name: 'NotificationHub',
	service: 'notification-hubs' as const,
	namespace: 'fixture.servicebus.windows.net',
	auth: 'device-code' as const,
	tenantId: 'fixture',
	clientId: randomUUID(),
	rememberSecret: false,
})
async function start(tenantId = 'fixture') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const value = profile()
	connectionId = (
		await host.request('nh.connect', {
			operationId: randomUUID(),
			profile: value,
			management: { resourceId, tenantId, clientId: value.clientId },
		})
	).connectionId
}
const target = (
	kind: 'hub' | 'namespace' = 'hub',
	name = 'alerts',
	policyName: string | null = null,
): NotificationHubTarget => ({
	scope: kind === 'namespace' ? { kind, name: '' } : { kind, name },
	policyName,
})
const get = (value: NotificationHubTarget) => host.request('nh.get', { ...req(), target: value })
const input = (value: NotificationHubTarget): NotificationHubChange => ({
	...req(),
	target: value,
	action: 'create',
	expectedRevision: null,
	settings: value.policyName === null ? defaultNotificationHubSettings() : null,
	rights: value.policyName !== null ? ['Send'] : null,
	keyType: null,
	acknowledged: true,
})
const change = (value: NotificationHubChange, signal?: AbortSignal) =>
	host.request('nh.change', value, { signal, waitForCancellation: true, timeout: 15000 })
async function edit(
	value: NotificationHubTarget,
	action: NotificationHubChange['action'] = 'update',
): Promise<NotificationHubChange> {
	const details = await get(value)
	return {
		...input(value),
		action,
		expectedRevision: details.revision,
		settings: action === 'update' ? details.settings : null,
		rights: action === 'update' ? details.rights : null,
		keyType: action === 'regenerate' ? 'PrimaryKey' : null,
	}
}
afterEach(async () => {
	await host?.stop()
})
it('checks the production ARM adapter, credential preservation, stale updates, key contracts and scoped cursors', () => {
	expect(execFileSync('dotnet', [dll, '--nh-checks'], { encoding: 'utf8' })).toContain(
		'Notification Hubs adapter checks passed',
	)
})
it('validates NotificationHub scope, acknowledgments and mutually exclusive settings at IPC boundaries', () => {
	expect(nhNameSchema.safeParse('../escape').success).toBe(false)
	expect(nhNameSchema.safeParse('team/orders').success).toBe(true)
	expect(nhNameSchema.safeParse('team/../orders').success).toBe(false)
	expect(nhNameSchema.safeParse('team//orders').success).toBe(false)
	expect(nhNameSchema.safeParse('a?key=x').success).toBe(false)
	const value = { ...input(target()), connectionId: randomUUID() }
	expect(nhChangeSchema.safeParse(value).success).toBe(true)
	expect(nhChangeSchema.safeParse({ ...value, acknowledged: false }).success).toBe(false)
	expect(nhChangeSchema.safeParse({ ...value, rights: ['Send'] }).success).toBe(false)
	expect(
		nhChangeSchema.safeParse({ ...value, settings: { registrationTtl: '00:00:00', tags: [] } })
			.success,
	).toBe(false)
	expect(
		nhConnectSchema.safeParse({
			id: randomUUID(),
			profileId: randomUUID(),
			management: {
				resourceId: resourceId.replace(
					'Microsoft.NotificationHubs',
					'Microsoft.ServiceBus',
				),
				tenantId: 'fixture',
				clientId: randomUUID(),
			},
		}).success,
	).toBe(false)
})
it('connects, pages independently scoped resource/policy lists and discards old handles on reset', async () => {
	await start()
	const base = {
		...req(),
		scope: { kind: 'namespace' as const, name: '' as const },
		kind: 'hubs' as const,
		continuationToken: null,
	}
	const first = await host.request('nh.list', base)
	expect(first.items.map((x) => x.target.scope.name)).toEqual(['alerts', 'archive'])
	expect(first.items[0].registrationTtl).toContain('10675199')
	const second = await host.request('nh.list', {
		...base,
		id: randomUUID(),
		continuationToken: first.continuationToken,
	})
	expect(second.items[0].target.scope.name).toBe('more-alerts')
	await expect(
		host.request('nh.list', {
			...base,
			id: randomUUID(),
			kind: 'policies',
			continuationToken: first.continuationToken,
		}),
	).rejects.toThrow('cursor')
	await host.request('nh.reset', {})
	await expect(get(target())).rejects.toThrow('expired')
})
it.each(['hub'] as const)(
	'creates, edits and deletes %s resources with retained deduplicated receipts',
	async (kind) => {
		await start()
		const value = target(kind, 'new-resource'),
			create = input(value)
		const receipt = await change(create)
		expect(receipt.status).toBe('confirmed')
		expect(await change(create)).toEqual(receipt)
		await expect(
			change({
				...create,
				settings: { ...create.settings!, registrationTtl: '30.00:00:00' },
			}),
		).rejects.toThrow('another request')
		expect(await host.request('nh.result', { ...req(), operationId: create.id })).toEqual(
			receipt,
		)
		const update = await edit(value)
		update.settings!.registrationTtl = '90.00:00:00'
		update.settings!.tags = [{ name: 'project', value: 'Commander' }]
		expect((await change(update)).status).toBe('confirmed')
		expect((await get(value)).settings).toEqual(update.settings)
		expect((await change({ ...update, id: randomUUID() })).status).toBe('failed')
		expect((await change(await edit(value, 'delete'))).status).toBe('confirmed')
		await expect(get(value)).rejects.toThrow('no longer exists')
	},
)
it.each(['namespace', 'hub'] as const)(
	'manages %s SAS policies and rotates only the selected slot',
	async (kind) => {
		await start()
		const value = target(kind, 'alerts', 'test-policy')
		expect((await change(input(value))).status).toBe('confirmed')
		const update = await edit(value)
		update.rights = ['Listen', 'Send', 'Manage']
		expect((await change(update)).status).toBe('confirmed')
		const key = async (keyType: 'PrimaryKey' | 'SecondaryKey') =>
			host.request('nh.key', { ...req(), target: value, keyType })
		const primary = await key('PrimaryKey'),
			secondary = await key('SecondaryKey')
		expect((await change(await edit(value, 'regenerate'))).status).toBe('confirmed')
		expect((await key('PrimaryKey')).key).not.toBe(primary.key)
		expect(await key('SecondaryKey')).toEqual(secondary)
		expect((await change(await edit(value, 'delete'))).status).toBe('confirmed')
	},
)
it('rejects missing acknowledgments in the backend before writes and retains failure receipts', async () => {
	await start()
	await expect(
		change({
			...input(target('hub', 'ack-required')),
			acknowledged: false,
		} as unknown as NotificationHubChange),
	).rejects.toThrow('Review')
	await expect(get(target('hub', 'ack-required'))).rejects.toThrow('no longer exists')
	const denied = await change(input(target('hub', 'denied')))
	expect(denied.status).toBe('failed')
	expect(denied.summary).toContain('Entra')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
	expect((await change(input(target('hub', 'rejected')))).status).toBe('failed')
	expect((await change(input(target('hub', 'alerts')))).summary).toContain('already exists')
})
it('keeps an unknown write receipt after an accepted write loses its response and never retries it', async () => {
	await start()
	const request = input(target('hub', 'unknown-create'))
	const result = await change(request)
	expect(result.status).toBe('unknown')
	expect(result.summary).not.toContain('SECRET')
	expect((await get(request.target)).settings).toEqual(request.settings)
	expect(await change(request)).toEqual(result)
})
it('reports cancellation before dispatch separately from cancellation during a write', async () => {
	await start()
	for (const [name, status] of [
		['preflight-slow', 'cancelled'],
		['write-slow', 'unknown'],
	] as const) {
		const abort = new AbortController(),
			request = input(target('hub', name))
		const pending = change(request, abort.signal)
		setTimeout(() => abort.abort(), 250)
		const result = await pending
		expect(result.status).toBe(status)
		expect(await host.request('nh.result', { ...req(), operationId: request.id })).toEqual(
			result,
		)
	}
})
it('sanitizes denied management connections and requires an exact namespace match', async () => {
	await expect(start('denied')).rejects.toThrow('Notification Hubs management access denied')
	await expect(
		host.request('nh.connect', {
			operationId: randomUUID(),
			profile: profile(),
			management: {
				resourceId: resourceId.replace('/namespaces/fixture', '/namespaces/another'),
				tenantId: 'fixture',
				clientId: randomUUID(),
			},
		}),
	).rejects.toThrow('matching Notification Hubs')
})
it('allows ARM administration for a SAS profile without retrieving its data credential', async () => {
	await start()
	const controller = new NotificationHubsController(host, () => {})
	const p = {
		...profile(),
		auth: 'sas' as const,
		tenantId: '',
		clientId: '',
		secretState: 'locked' as const,
	}
	const value = await controller.connect(
		{
			id: randomUUID(),
			profileId: p.id,
			management: { resourceId, tenantId: 'fixture', clientId: randomUUID() },
		},
		p,
		new AbortController().signal,
	)
	expect(controller.require(value.connectionId)).toEqual(value)
	await controller.reset()
	expect(() => controller.require(value.connectionId)).toThrow('again')
})

it('bounds registration lifetimes, Azure tags and extended Notification Hubs policy names', () => {
	for (const value of [
		'00:00:00',
		'-01:00:00',
		'24:00:00',
		'00:60:00',
		'10675199.02:48:05.4775808',
		'99999999.00:00:00',
		'1:00:00',
	]) {
		expect(
			nhSettingsSchema.safeParse({ registrationTtl: value, tags: [] }).success,
			value,
		).toBe(false)
	}
	for (const value of ['00:00:00.0000001', '90.00:00:00', '10675199.02:48:05.4775807']) {
		expect(
			nhSettingsSchema.safeParse({ registrationTtl: value, tags: [] }).success,
			value,
		).toBe(true)
	}
	for (const tags of [
		[
			{ name: 'env', value: 'a' },
			{ name: 'ENV', value: 'b' },
		],
		[{ name: 'bad/name', value: '' }],
		[{ name: ' ', value: '' }],
		[{ name: 'env', value: 'x'.repeat(257) }],
	]) {
		expect(nhSettingsSchema.safeParse({ registrationTtl: '90.00:00:00', tags }).success).toBe(
			false,
		)
	}
	expect(nhPolicyNameSchema.safeParse('policy!()*' + 'x'.repeat(200)).success).toBe(true)
	for (const value of ['.', '..', 'a/b', 'a?b', 'x'.repeat(257)])
		expect(nhPolicyNameSchema.safeParse(value).success).toBe(false)
})
it('treats an asynchronous response as unknown and retains it without a second write', async () => {
	await start()
	const value = input(target('hub', 'async-accepted'))
	const result = await change(value)
	expect(result.status).toBe('unknown')
	expect((await get(value.target)).settings).toEqual(value.settings)
	expect(await change(value)).toEqual(result)
})
it('rejects invalid tag edits in the backend before sending a write', async () => {
	await start()
	const value = await edit(target())
	value.settings!.tags = [
		{ name: 'environment', value: 'a' },
		{ name: 'ENVIRONMENT', value: 'b' },
	]
	await expect(change(value)).rejects.toThrow('distinct Azure tags')
	expect((await get(target())).settings?.tags).toEqual([
		{ name: 'environment', value: 'fixture' },
	])
})
