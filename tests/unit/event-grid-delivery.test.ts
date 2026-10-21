import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import {
	eventGridAdminChangeSchema,
	type EventGridAdminChange,
} from '../../src/shared/contracts/event-grid/administration'
import {
	eventGridDeliverySchema,
	eventGridHeaderSchema,
	eventGridIdentitySchema,
} from '../../src/shared/contracts/event-grid/delivery'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const prefix =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/'
const root = prefix + 'Microsoft.EventGrid/namespaces/fixture'
const identityId = prefix + 'Microsoft.ManagedIdentity/userAssignedIdentities/fixture-identity'
const system = { type: 'SystemAssigned' as const, userAssignedIdentity: null }
const destination = {
	endpointType: 'EventHub' as const,
	endpointUrl: null,
	resourceId: prefix + 'Microsoft.EventHub/namespaces/fixture/eventhubs/orders',
	queueName: null,
}
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	const profile = {
		id: randomUUID(),
		name: 'Grid',
		service: 'event-grid' as const,
		namespace: 'fixture.westeurope-1.eventgrid.azure.net',
		auth: 'device-code' as const,
		tenantId: 'fixture',
		clientId: randomUUID(),
		rememberSecret: false,
	}
	connectionId = (
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile,
			management: {
				resourceId: root,
				tenantId: profile.tenantId,
				clientId: profile.clientId,
			},
		})
	).connectionId
}
const target = { kind: 'subscription' as const, topicName: 'orders', subscriptionName: 'audit' }
async function edit(): Promise<EventGridAdminChange> {
	const read = await host.request('eg.admin.get', { ...request(), target })
	return {
		...request(),
		target,
		action: 'update',
		expectedRevision: read.revision,
		retentionDays: null,
		settings: read.settings!,
		destination: null,
		acknowledged: true,
		confirmation: null,
		delivery: { identity: null, headers: null, deadLetter: null },
	}
}
afterEach(async () => {
	await host?.stop()
})
it('checks production delivery ARM bodies, identity preflights, redaction guards, clearing and preservation', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-grid-delivery-checks'], { encoding: 'utf8' }),
	).toContain('Event Grid delivery adapter checks passed (65 assertions)')
})
it.each([
	{ name: 'aeg-hidden', type: 'Static', value: 'x', isSecret: true },
	{ name: 'Content-Type', type: 'Static', value: 'x', isSecret: true },
	{ name: 'bad name', type: 'Static', value: 'x', isSecret: true },
	{ name: 'X-App', type: 'Static', value: 'x\r\nInjected: y', isSecret: true },
	{ name: 'X-App', type: 'Static', value: '界'.repeat(1366), isSecret: true },
	{ name: 'X-App', type: 'Static', value: 'x', isSecret: true, sourceField: 'data.x' },
	{ name: 'X-App', type: 'Dynamic', sourceField: '' },
	{ name: 'X-App', type: 'Dynamic', sourceField: 'data.x', value: 'x' },
])('rejects invalid or oversized header mapping %#', (value) => {
	expect(eventGridHeaderSchema.safeParse(value).success).toBe(false)
})
it.each([
	{
		type: 'UserAssigned',
		userAssignedIdentity: prefix + 'Microsoft.Storage/storageAccounts/test',
	},
	{ type: 'SystemAssigned', userAssignedIdentity: identityId },
	{ type: 'None', userAssignedIdentity: identityId },
	{ type: 'UserAssigned', userAssignedIdentity: identityId + '?sig=SECRET' },
	{ type: 'UserAssigned', userAssignedIdentity: identityId + '/..' },
	{ type: 'UserAssigned', userAssignedIdentity: null },
])('bounds managed identity input %#', (value) => {
	expect(eventGridIdentitySchema.safeParse(value).success).toBe(false)
})
it('distinguishes keeping from clearing and bounds dead-letter configuration', () => {
	const value = { identity: null, headers: null, deadLetter: null }
	expect(eventGridDeliverySchema.parse(value)).toEqual(value)
	expect(
		eventGridDeliverySchema.parse({
			...value,
			headers: [],
			deadLetter: { action: 'clear', resourceId: null, containerName: null, identity: null },
		}).headers,
	).toEqual([])
	const dead = {
		action: 'set',
		resourceId: prefix + 'Microsoft.Storage/storageAccounts/fixturestore',
		containerName: 'deadletters',
		identity: system,
	}
	expect(eventGridDeliverySchema.safeParse({ ...value, deadLetter: dead }).success).toBe(true)
	for (const patch of [
		{ containerName: 'bad--container' },
		{ resourceId: dead.resourceId + '/blobServices/default/containers/abc' },
		{ identity: { type: 'None', userAssignedIdentity: null } },
		{ url: 'https://evil.invalid' },
	])
		expect(
			eventGridDeliverySchema.safeParse({ ...value, deadLetter: { ...dead, ...patch } })
				.success,
		).toBe(false)
	expect(
		eventGridDeliverySchema.safeParse({
			...value,
			headers: [
				{ name: 'X-App', type: 'Static', value: 'x', isSecret: true },
				{ name: 'x-app', type: 'Dynamic', sourceField: 'data.x' },
			],
		}).success,
	).toBe(false)
})
it('requires explicit identity and fresh headers when replacing an existing destination', async () => {
	await start()
	const value = { ...(await edit()), destination }
	expect(eventGridAdminChangeSchema.safeParse(value).success).toBe(false)
	await expect(host.request('eg.admin.change', value)).rejects.toThrow(/explicit identity/)
	expect(
		eventGridAdminChangeSchema.safeParse({
			...value,
			delivery: { identity: system, headers: [], deadLetter: null },
		}).success,
	).toBe(true)
})
it('changes delivery through strict backend IPC and keeps all values out of projections and receipts', async () => {
	await start()
	let value = await edit()
	value.delivery = {
		identity: null,
		headers: [
			{ name: 'X-App', type: 'Static', value: 'SECRET-STATIC', isSecret: true },
			{ name: 'X-Route', type: 'Dynamic', sourceField: 'data.SECRET-PATH' },
		],
		deadLetter: null,
	}
	const receipt = await host.request('eg.admin.change', value)
	expect(receipt.status).toBe('confirmed')
	expect(await host.request('eg.admin.change', value)).toEqual(receipt)
	expect(await host.request('eg.admin.result', { ...request(), operationId: value.id })).toEqual(
		receipt,
	)
	const read = await host.request('eg.admin.get', { ...request(), target })
	expect(read.delivery?.headers).toEqual([
		{ name: 'X-App', type: 'Static', isSecret: true },
		{ name: 'X-Route', type: 'Dynamic', isSecret: false },
	])
	expect(JSON.stringify([read, receipt])).not.toContain('SECRET')
	await expect(
		host.request('eg.admin.change', { ...value, delivery: { ...value.delivery, headers: [] } }),
	).rejects.toThrow(/operation ID/)
	value = await edit()
	value.destination = destination
	value.delivery = {
		identity: system,
		headers: [],
		deadLetter: {
			action: 'set',
			resourceId: prefix + 'Microsoft.Storage/storageAccounts/fixturestore',
			containerName: 'deadletters',
			identity: { type: 'UserAssigned', userAssignedIdentity: identityId },
		},
	}
	expect((await host.request('eg.admin.change', value)).status).toBe('confirmed')
	const after = await host.request('eg.admin.get', { ...request(), target })
	expect(after.delivery?.identity).toEqual(system)
	expect(after.delivery?.resourceId).toBe(destination.resourceId)
	expect(after.delivery?.deadLetter?.containerName).toBe('deadletters')
	const stale = await host.request('eg.admin.change', { ...value, ...request() })
	expect(stale.status).toBe('failed')
	expect(stale.summary).toContain('changed since review')
})
it('preflights namespace membership without leaking submitted configuration on a failed receipt', async () => {
	await start()
	const value = await edit()
	value.destination = destination
	value.delivery = {
		identity: { type: 'UserAssigned', userAssignedIdentity: identityId + '-missing' },
		headers: [{ name: 'X-App', type: 'Static', value: 'SECRET-REJECTED', isSecret: true }],
		deadLetter: null,
	}
	const receipt = await host.request('eg.admin.change', value)
	expect(receipt.status).toBe('failed')
	expect(receipt.summary).toContain('not configured')
	expect(JSON.stringify(receipt)).not.toContain('SECRET')
	expect(
		(await host.request('eg.admin.get', { ...request(), target })).delivery?.destinationType,
	).toBe('WebHook')
})
it('rejects extra nested fields and queue-mode push configuration at both boundaries', async () => {
	await start()
	const value = await edit()
	for (const delivery of [
		{ identity: system, headers: null, deadLetter: null, arbitraryHttp: true },
		{
			identity: null,
			headers: [
				{
					name: 'X-App',
					type: 'Static',
					value: 'x',
					isSecret: true,
					url: 'https://evil.invalid',
				},
			],
			deadLetter: null,
		},
	]) {
		expect(eventGridAdminChangeSchema.safeParse({ ...value, delivery }).success).toBe(false)
		await expect(
			host.request('eg.admin.change', { ...value, delivery } as never),
		).rejects.toThrow()
	}
	const queue = {
		...value,
		target: { ...target, subscriptionName: 'fulfillment' },
		settings: {
			...value.settings!,
			deliveryMode: 'Queue' as const,
			receiveLockDurationInSeconds: 60,
		},
		delivery: { identity: system, headers: null, deadLetter: null },
	}
	expect(eventGridAdminChangeSchema.safeParse(queue).success).toBe(false)
	await expect(host.request('eg.admin.change', queue)).rejects.toThrow(/Push/)
})
