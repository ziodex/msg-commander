import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { RelayController } from '../../src/main/features/relay/controller'
import {
	defaultRelaySettings,
	relayChangeSchema,
	relayConnectSchema,
	relayNameSchema,
	type RelayChange,
	type RelayTarget,
} from '../../src/shared/contracts/relay/core'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Relay/namespaces/fixture'
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
const profile = () => ({
	id: randomUUID(),
	name: 'Relay',
	service: 'relay' as const,
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
		await host.request('relay.connect', {
			operationId: randomUUID(),
			profile: value,
			management: { resourceId, tenantId, clientId: value.clientId },
		})
	).connectionId
}
const target = (
	kind: 'hybrid' | 'wcf' | 'namespace' = 'hybrid',
	name = 'bridge',
	policyName: string | null = null,
): RelayTarget => ({
	scope: kind === 'namespace' ? { kind, name: '' } : { kind, name },
	policyName,
})
const get = (value: RelayTarget) => host.request('relay.get', { ...req(), target: value })
const input = (value: RelayTarget): RelayChange => ({
	...req(),
	target: value,
	action: 'create',
	expectedRevision: null,
	settings:
		value.policyName === null
			? defaultRelaySettings(value.scope.kind === 'wcf' ? 'wcf' : 'hybrid')
			: null,
	rights: value.policyName !== null ? ['Send'] : null,
	keyType: null,
	acknowledged: true,
})
const change = (value: RelayChange, signal?: AbortSignal) =>
	host.request('relay.change', value, { signal, waitForCancellation: true, timeout: 15000 })
async function edit(
	value: RelayTarget,
	action: RelayChange['action'] = 'update',
): Promise<RelayChange> {
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
it('checks the production ARM adapter, property preservation, stale updates, WCF fields and scoped cursors', () => {
	expect(execFileSync('dotnet', [dll, '--relay-checks'], { encoding: 'utf8' })).toContain(
		'Relay adapter checks passed',
	)
})
it('validates Relay scope, acknowledgments and mutually exclusive settings at IPC boundaries', () => {
	expect(relayNameSchema.safeParse('../escape').success).toBe(false)
	expect(relayNameSchema.safeParse('team/orders').success).toBe(true)
	expect(relayNameSchema.safeParse('team/../orders').success).toBe(false)
	expect(relayNameSchema.safeParse('team//orders').success).toBe(false)
	expect(relayNameSchema.safeParse('trailing.').success).toBe(false)
	expect(relayNameSchema.safeParse('a?key=x').success).toBe(false)
	const value = { ...input(target()), connectionId: randomUUID() }
	expect(relayChangeSchema.safeParse(value).success).toBe(true)
	expect(relayChangeSchema.safeParse({ ...value, acknowledged: false }).success).toBe(false)
	expect(relayChangeSchema.safeParse({ ...value, rights: ['Send'] }).success).toBe(false)
	expect(
		relayChangeSchema.safeParse({
			...value,
			settings: { ...value.settings, relayType: 'Http' },
		}).success,
	).toBe(false)
	expect(
		relayConnectSchema.safeParse({
			id: randomUUID(),
			profileId: randomUUID(),
			management: {
				resourceId: resourceId.replace('Microsoft.Relay', 'Microsoft.ServiceBus'),
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
		kind: 'hybrid' as const,
		continuationToken: null,
	}
	const first = await host.request('relay.list', base)
	expect(first.items.map((x) => x.target.scope.name)).toEqual(['bridge', 'archive'])
	expect(first.items[0].listenerCount).toBe(2)
	const second = await host.request('relay.list', {
		...base,
		id: randomUUID(),
		continuationToken: first.continuationToken,
	})
	expect(second.items[0].target.scope.name).toBe('more-bridge')
	await expect(
		host.request('relay.list', {
			...base,
			id: randomUUID(),
			kind: 'wcf',
			continuationToken: first.continuationToken,
		}),
	).rejects.toThrow('cursor')
	await host.request('relay.reset', {})
	await expect(get(target())).rejects.toThrow('expired')
})
it.each(['hybrid', 'wcf'] as const)(
	'creates, edits and deletes %s resources with retained deduplicated receipts',
	async (kind) => {
		await start()
		const value = target(kind, 'new-resource'),
			create = input(value)
		const receipt = await change(create)
		expect(receipt.status).toBe('confirmed')
		expect(await change(create)).toEqual(receipt)
		await expect(
			change({ ...create, settings: { ...create.settings!, userMetadata: 'other' } }),
		).rejects.toThrow('another request')
		expect(await host.request('relay.result', { ...req(), operationId: create.id })).toEqual(
			receipt,
		)
		const update = await edit(value)
		update.settings!.userMetadata = 'Updated metadata'
		expect((await change(update)).status).toBe('confirmed')
		expect((await get(value)).settings?.userMetadata).toBe('Updated metadata')
		expect((await change({ ...update, id: randomUUID() })).status).toBe('failed')
		expect((await change(await edit(value, 'delete'))).status).toBe('confirmed')
		await expect(get(value)).rejects.toThrow('no longer exists')
	},
)
it.each(['namespace', 'hybrid', 'wcf'] as const)(
	'manages %s SAS policies and rotates only the selected slot',
	async (kind) => {
		await start()
		const value = target(kind, kind === 'wcf' ? 'legacy' : 'bridge', 'test-policy')
		expect((await change(input(value))).status).toBe('confirmed')
		const update = await edit(value)
		update.rights = ['Listen', 'Send', 'Manage']
		expect((await change(update)).status).toBe('confirmed')
		const key = async (keyType: 'PrimaryKey' | 'SecondaryKey') =>
			host.request('relay.key', { ...req(), target: value, keyType })
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
			...input(target('hybrid', 'ack-required')),
			acknowledged: false,
		} as unknown as RelayChange),
	).rejects.toThrow('Review')
	await expect(get(target('hybrid', 'ack-required'))).rejects.toThrow('no longer exists')
	const denied = await change(input(target('hybrid', 'denied')))
	expect(denied.status).toBe('failed')
	expect(denied.summary).toContain('Entra')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
	expect((await change(input(target('hybrid', 'rejected')))).status).toBe('failed')
	expect((await change(input(target('hybrid', 'bridge')))).summary).toContain('already exists')
})
it('keeps an unknown write receipt after an accepted write loses its response and never retries it', async () => {
	await start()
	const request = input(target('hybrid', 'unknown-create'))
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
			request = input(target('hybrid', name))
		const pending = change(request, abort.signal)
		setTimeout(() => abort.abort(), 250)
		const result = await pending
		expect(result.status).toBe(status)
		expect(await host.request('relay.result', { ...req(), operationId: request.id })).toEqual(
			result,
		)
	}
})
it('sanitizes denied management connections and requires an exact namespace match', async () => {
	await expect(start('denied')).rejects.toThrow('Relay management access denied')
	await expect(
		host.request('relay.connect', {
			operationId: randomUUID(),
			profile: profile(),
			management: {
				resourceId: resourceId.replace('/namespaces/fixture', '/namespaces/another'),
				tenantId: 'fixture',
				clientId: randomUUID(),
			},
		}),
	).rejects.toThrow('matching Relay')
})
it('allows ARM administration for a SAS profile without retrieving its data credential', async () => {
	await start()
	const controller = new RelayController(host, () => {})
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
