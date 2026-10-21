import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	defaultEventHubSettings,
	eventAdminChangeSchema,
	eventAdminConfirmation,
	type EventAdminTarget,
	type EventAdminChange,
} from '../../src/shared/contracts/event-hubs/administration'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture'
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
async function start(tier = 'fixture', management = true) {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (
		await host.request('eh.connect', {
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
			hubName: management ? '' : 'telemetry',
			management: management ? { resourceId, tenantId: tier, clientId: randomUUID() } : null,
		})
	).connectionId
}
const get = (target: EventAdminTarget) => host.request('eh.admin.get', { ...req(), target })
const key = (
	target: Extract<EventAdminTarget, { kind: 'policy' }>,
	keyType: 'PrimaryKey' | 'SecondaryKey' = 'PrimaryKey',
) => host.request('eh.admin.key', { ...req(), target, keyType })
const input = (
	target: EventAdminTarget,
	action: EventAdminChange['action'] = 'create',
): EventAdminChange => ({
	...req(),
	target,
	action,
	expectedRevision: null,
	settings: target.kind === 'hub' ? defaultEventHubSettings() : null,
	userMetadata: target.kind === 'group' ? 'metadata' : null,
	rights: target.kind === 'policy' ? ['Send'] : null,
	keyType: null,
	acknowledged: true,
	confirmation: '',
})
const change = (v: EventAdminChange, signal?: AbortSignal) =>
	host.request('eh.admin.change', v, { signal, waitForCancellation: true, timeout: 15000 })
async function edit(
	target: EventAdminTarget,
	action: EventAdminChange['action'] = 'update',
): Promise<EventAdminChange> {
	const current = await get(target)
	return {
		...input(target, action),
		expectedRevision: current.revision,
		settings: action === 'update' ? current.hub : null,
		userMetadata: action === 'update' ? current.userMetadata : null,
		rights: action === 'update' ? current.rights : null,
		keyType: action === 'regenerate' ? 'PrimaryKey' : null,
		confirmation: eventAdminConfirmation(
			action,
			target,
			action === 'regenerate' ? 'PrimaryKey' : null,
		),
	}
}
afterEach(async () => {
	await host?.stop()
})
it('maps ARM SDK payloads, preserves Capture and unrelated fields, and enforces exclusive key slots', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-hubs-admin-checks'], { encoding: 'utf8' }),
	).toContain('Event Hubs administration adapter checks passed')
})
it('requires management identity independently of event data access', async () => {
	await start('fixture', false)
	await expect(host.request('eh.admin.context', req())).rejects.toThrow('Entra management')
	await expect(change(input({ kind: 'hub', name: 'admin-new' }))).rejects.toThrow(
		'Entra management',
	)
})
it('creates, edits, reloads and deletes hubs and consumer groups through ARM SDK routes', async () => {
	await start()
	expect(await host.request('eh.admin.context', req())).toMatchObject({
		resourceId,
		tier: 'Standard',
		localAuthDisabled: false,
	})
	const hub: EventAdminTarget = { kind: 'hub', name: 'admin-orders' },
		group: EventAdminTarget = { kind: 'group', hubName: hub.name, name: 'billing' }
	expect(await change(input(hub))).toMatchObject({ status: 'confirmed' })
	let value = await get(hub)
	expect(value.hub).toMatchObject({
		partitionCount: 2,
		retentionHours: 24,
		cleanupPolicy: 'Delete',
	})
	const update = await edit(hub)
	update.settings!.retentionHours = 72
	update.settings!.status = 'SendDisabled'
	update.settings!.userMetadata = 'Málaga 🚀'
	expect((await change(update)).status).toBe('confirmed')
	value = await get(hub)
	expect(value.hub).toMatchObject({
		retentionHours: 72,
		status: 'SendDisabled',
		userMetadata: 'Málaga 🚀',
	})
	expect((await change(input(group))).status).toBe('confirmed')
	const groupEdit = await edit(group)
	groupEdit.userMetadata = 'processor v2'
	expect((await change(groupEdit)).status).toBe('confirmed')
	expect((await get(group)).userMetadata).toBe('processor v2')
	expect((await change(await edit(group, 'delete'))).status).toBe('confirmed')
	await expect(get(group)).rejects.toThrow('no longer exists')
	expect((await change(await edit(hub, 'delete'))).status).toBe('confirmed')
	await expect(get(hub)).rejects.toThrow('no longer exists')
})
it('prevents create-overwrite and stale settings from overwriting newer changes', async () => {
	await start()
	const target: EventAdminTarget = { kind: 'hub', name: 'telemetry' }
	expect(await change(input(target))).toMatchObject({
		status: 'failed',
		summary: expect.stringContaining('already exists'),
	})
	const first = await edit(target),
		stale = { ...first, id: randomUUID() }
	first.settings!.userMetadata = 'newer'
	expect((await change(first)).status).toBe('confirmed')
	expect(await change(stale)).toMatchObject({
		status: 'failed',
		summary: expect.stringContaining('changed'),
	})
	expect((await get(target)).hub!.userMetadata).toBe('newer')
})
it('applies tier-specific retention and partition rules while preserving immutable cleanup policy', async () => {
	await start()
	const target: EventAdminTarget = { kind: 'hub', name: 'telemetry' }
	let value = await edit(target)
	value.settings!.partitionCount = 3
	expect((await change(value)).status).toBe('failed')
	value = await edit(target)
	value.settings!.retentionHours = 169
	expect((await change(value)).status).toBe('failed')
	value = await edit(target)
	value.settings!.cleanupPolicy = 'Compact'
	value.settings!.retentionHours = null
	expect((await change(value)).status).toBe('failed')
	await host.stop()
	await start('premium')
	value = await edit(target)
	value.settings!.partitionCount = 3
	value.settings!.retentionHours = 2160
	expect((await change(value)).status).toBe('confirmed')
	value = await edit(target)
	value.settings!.partitionCount = 2
	expect((await change(value)).status).toBe('failed')
})
it('supports compacted hub creation and blocks Basic Capture, compaction and extra consumer groups', async () => {
	await start('premium')
	const target: EventAdminTarget = { kind: 'hub', name: 'admin-compact' }
	const value = input(target)
	value.settings!.cleanupPolicy = 'Compact'
	value.settings!.retentionHours = null
	value.settings!.tombstoneHours = 48
	value.settings!.minCompactionLagMinutes = 10
	expect((await change(value)).status).toBe('confirmed')
	expect((await get(target)).hub).toMatchObject({
		cleanupPolicy: 'Compact',
		retentionHours: null,
		tombstoneHours: 48,
		minCompactionLagMinutes: 10,
	})
	await host.stop()
	await start('basic')
	expect((await change({ ...value, ...req() })).status).toBe('failed')
	expect(
		(await change(input({ kind: 'group', hubName: 'telemetry', name: 'extra' }))).status,
	).toBe('failed')
})
it('pages namespace and hub policies using scope-bound opaque cursors', async () => {
	await start()
	const first = await host.request('eh.admin.policies', {
		...req(),
		hubName: '',
		continuationToken: null,
	})
	expect(first.items[0].name).toBe('RootManageSharedAccessKey')
	expect(first.continuationToken).toMatch(/^[0-9a-f-]{36}$/)
	expect(JSON.stringify(first)).not.toContain('OFFLINE-PRIMARY')
	expect(
		(
			await host.request('eh.admin.policies', {
				...req(),
				hubName: '',
				continuationToken: first.continuationToken,
			})
		).items[0].name,
	).toBe('publisher')
	await expect(
		host.request('eh.admin.policies', {
			...req(),
			hubName: 'telemetry',
			continuationToken: first.continuationToken,
		}),
	).rejects.toThrow('another scope')
	expect(
		(
			await host.request('eh.admin.policies', {
				...req(),
				hubName: 'telemetry',
				continuationToken: null,
			})
		).items[0].name,
	).toBe('hub-reader')
})
it('creates and edits both policy scopes, reveals one slot, rotates independently and never leaks keys in receipts', async () => {
	await start()
	for (const hubName of ['', 'telemetry']) {
		const target = { kind: 'policy' as const, hubName, name: 'admin-publisher' }
		expect((await change(input(target))).status).toBe('confirmed')
		let value = await edit(target)
		value.rights = ['Send', 'Listen', 'Manage']
		expect((await change(value)).status).toBe('confirmed')
		expect((await get(target)).rights).toEqual(['Listen', 'Manage', 'Send'])
		const primary = await key(target),
			secondary = await key(target, 'SecondaryKey')
		expect(primary.key).not.toBe(secondary.key)
		if (hubName) expect(primary.connectionString).toContain('EntityPath=telemetry')
		else expect(primary.connectionString).not.toContain('EntityPath')
		value = await edit(target, 'regenerate')
		const result = await change(value)
		expect(result.status).toBe('confirmed')
		expect(JSON.stringify(result)).not.toContain('OFFLINE')
		expect((await key(target)).key).not.toBe(primary.key)
		expect(await key(target, 'SecondaryKey')).toEqual(secondary)
		expect((await change(await edit(target, 'delete'))).status).toBe('confirmed')
		await expect(key(target)).rejects.toThrow('no longer exists')
	}
})
it('rejects invalid fields, rights, resource scopes and missing acknowledgement at both boundaries', async () => {
	await start()
	const target = { kind: 'hub' as const, name: 'admin-new' }
	for (const delta of [
		{ acknowledged: false },
		{ rights: ['Send'] },
		{ expectedRevision: 'A'.repeat(64) },
		{ target: { kind: 'hub', name: '../escape' } },
		{ target: { kind: 'policy', name: 'bad', hubName: '../escape' } },
		{ action: 'regenerate', keyType: 'PrimaryKey' },
		{ settings: { ...defaultEventHubSettings(), partitionCount: 0 } },
		{
			settings: {
				...defaultEventHubSettings(),
				capture: { mode: 'preserve', secret: 'ignored' },
			},
		},
	]) {
		const value = { ...input(target), ...delta }
		expect(eventAdminChangeSchema.safeParse(value).success).toBe(false)
		await expect(change(value as EventAdminChange)).rejects.toThrow()
	}
	const policy = input({ kind: 'policy', name: 'bad', hubName: '' })
	policy.rights = ['Manage']
	expect(eventAdminChangeSchema.safeParse(policy).success).toBe(false)
	await expect(change(policy)).rejects.toThrow()
})
it('binds destructive confirmation to the exact target and slot and protects the default group', async () => {
	await start()
	let value = await edit({ kind: 'hub', name: 'telemetry' }, 'delete')
	value.confirmation = 'DELETE archive'
	await expect(change(value)).rejects.toThrow('confirmation')
	value = await edit({ kind: 'policy', hubName: '', name: 'publisher' }, 'regenerate')
	value.keyType = 'SecondaryKey'
	expect(eventAdminChangeSchema.safeParse(value).success).toBe(false)
	await expect(change(value)).rejects.toThrow('confirmation')
	value = await edit({ kind: 'group', hubName: 'telemetry', name: '$Default' }, 'delete')
	await expect(change(value)).rejects.toThrow('$Default')
})
it('retains a lost-acknowledgement receipt without repeating an accepted mutation', async () => {
	await start()
	const value = input({ kind: 'hub', name: 'admin-unknown' })
	const result = await change(value)
	expect(result.status).toBe('unknown')
	expect((await get(value.target)).hub).toBeTruthy()
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(await change(value)).toEqual(result)
	expect(await host.request('eh.admin.result', { ...req(), operationId: value.id })).toEqual(
		result,
	)
	await expect(change({ ...value, confirmation: 'changed' })).rejects.toThrow('another request')
})
it('distinguishes rejected writes, cancelled preflight and uncertain in-flight writes', async () => {
	await start()
	expect((await change(input({ kind: 'hub', name: 'admin-rejected' }))).status).toBe('failed')
	for (const [name, status] of [
		['admin-preflight-slow', 'cancelled'],
		['admin-slow', 'unknown'],
	]) {
		const stop = new AbortController(),
			value = input({ kind: 'hub', name })
		const timer = setTimeout(() => stop.abort(), 150)
		expect((await change(value, stop.signal)).status).toBe(status)
		clearTimeout(timer)
	}
})
it('expires administration receipts with the connection and keeps errors sanitized', async () => {
	await start()
	const value = input({ kind: 'hub', name: 'admin-denied' })
	const result = await change(value)
	expect(result.status).toBe('failed')
	expect(result.summary).toContain('denied')
	expect(JSON.stringify(result)).not.toContain('SECRET')
	await host.request('eh.reset', {})
	await expect(
		host.request('eh.admin.result', { ...req(), operationId: value.id }),
	).rejects.toThrow('expired')
})
it('routes management re-authentication codes to the active operation', async () => {
	await start()
	const ids: string[] = []
	host.on('event', (e) => {
		if (e.type === 'device-code') ids.push(e.operationId)
	})
	const value = input({ kind: 'hub', name: 'admin-reauth' })
	expect((await change(value)).status).toBe('confirmed')
	expect(ids.length).toBeGreaterThan(0)
	expect(new Set(ids)).toEqual(new Set([value.id]))
})
