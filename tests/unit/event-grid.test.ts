import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { EventGridController } from '../../src/main/features/event-grid/controller'
import { profileInputSchema } from '../../src/shared/contracts'
import {
	eventGridConnectSchema,
	eventGridListSchema,
	eventGridTargetSchema,
	eventGridNamespace,
	eventGridTopic,
} from '../../src/shared/contracts/event-grid/core'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
export const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
let host: Backend, connectionId: string
const profile = () => ({
	id: randomUUID(),
	name: 'Event Grid',
	service: 'event-grid' as const,
	namespace: 'fixture.westeurope-1.eventgrid.azure.net',
	auth: 'device-code' as const,
	tenantId: 'fixture',
	clientId: randomUUID(),
	rememberSecret: false,
})
const setup = () => ({
	id: randomUUID(),
	profileId: randomUUID(),
	management: { resourceId, tenantId: 'fixture', clientId: randomUUID() },
})
const request = () => ({ id: randomUUID(), connectionId })
async function start(tenantId = 'fixture') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const value = profile()
	connectionId = (
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile: value,
			management: { resourceId, tenantId, clientId: value.clientId },
		})
	).connectionId
}
afterEach(async () => {
	await host?.stop()
})
it('checks the production GET-only ARM transport, exact resource scope, safe projection, 19 operators and JSON limits', () => {
	expect(execFileSync('dotnet', [dll, '--event-grid-checks'], { encoding: 'utf8' })).toContain(
		'Event Grid adapter checks passed',
	)
})
it('validates Entra HTTP namespace profiles, parent relationships and named request boundaries', () => {
	expect(profileInputSchema.safeParse(profile()).success).toBe(true)
	for (const namespace of [
		'fixture.servicebus.windows.net',
		'https://fixture.westeurope-1.eventgrid.azure.net',
		'fixture.mqtt.eventgrid.azure.net/path',
	])
		expect(profileInputSchema.safeParse({ ...profile(), namespace }).success).toBe(false)
	expect(
		profileInputSchema.safeParse({ ...profile(), auth: 'sas', secret: 'SECRET' }).success,
	).toBe(false)
	expect(
		eventGridConnectSchema.safeParse({ ...setup(), url: 'https://evil.invalid' }).success,
	).toBe(false)
	expect(
		eventGridConnectSchema.safeParse({
			...setup(),
			management: { ...setup().management, resourceId: resourceId + '/topics/orders' },
		}).success,
	).toBe(false)
	expect(
		eventGridTargetSchema.safeParse({
			kind: 'namespace',
			topicName: 'orders',
			subscriptionName: null,
		}).success,
	).toBe(false)
	expect(eventGridTargetSchema.safeParse({ ...eventGridTopic('../escape') }).success).toBe(false)
	expect(
		eventGridListSchema.safeParse({
			id: randomUUID(),
			connectionId: randomUUID(),
			target: { kind: 'subscription', topicName: 'orders', subscriptionName: 'audit' },
			continuationToken: null,
		}).success,
	).toBe(false)
})
it('pages topics and subscriptions with opaque, parent-scoped cursors invalidated by refresh', async () => {
	await start()
	const list = (target = eventGridNamespace, continuationToken: string | null = null) =>
		host.request('eg.list', { ...request(), target, continuationToken })
	const page = await list()
	expect(page.items.map((i) => i.name)).toEqual(['orders', 'archive'])
	expect(page.continuationToken).toMatch(/^[a-f0-9-]{36}$/)
	const sub = await list(eventGridTopic('orders'))
	expect(sub.items.map((i) => i.deliveryMode)).toEqual(['Queue', 'Push'])
	await expect(list(eventGridTopic('orders'), page.continuationToken)).rejects.toThrow(/cursor/)
	expect((await list(eventGridNamespace, page.continuationToken)).items).toHaveLength(4)
	expect((await list(eventGridTopic('orders'), sub.continuationToken)).items[0].name).toBe(
		'extra',
	)
	await list()
	await expect(list(eventGridNamespace, page.continuationToken)).rejects.toThrow(/cursor/)
})
it('inspects subscriptions with precise JSON filters and sanitized delivery settings', async () => {
	await start()
	const target = {
		kind: 'subscription' as const,
		topicName: 'orders',
		subscriptionName: 'fulfillment',
	}
	const value = await host.request('eg.get', { ...request(), target })
	expect(value.filters?.includedEventTypes).toEqual(['Order.Created', 'Order.Updated'])
	expect(value.filters?.filters[0].definitionJson).toContain('9007199254740993')
	expect(value.deliveryJson).toContain('"receiveLockDurationInSeconds": 60')
	const audit = await host.request('eg.get', {
		...request(),
		target: { ...target, subscriptionName: 'audit' },
	})
	expect(audit.filters?.filters[0].known).toBe(false)
	expect(audit.warning).toContain('omitted')
	expect(JSON.stringify(audit)).not.toContain('SECRET')
	expect(audit.deliveryJson).toContain('WebHook')
})
it('returns sanitized authorization and missing-resource errors', async () => {
	await start()
	for (const topic of ['denied', 'missing'])
		await expect(
			host.request('eg.get', { ...request(), target: eventGridTopic(topic) }),
		).rejects.toThrow(/Event Grid|resource/)
	try {
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile: profile(),
			management: { resourceId, tenantId: 'denied', clientId: randomUUID() },
		})
	} catch (e) {
		expect(String(e)).not.toContain('SECRET')
		expect(String(e)).toContain('permission')
	}
})
it('cancels slow reads and preserves the connection for an explicit retry', async () => {
	await start()
	const cancel = new AbortController(),
		pending = host.request(
			'eg.get',
			{ ...request(), target: eventGridTopic('slow') },
			{ signal: cancel.signal },
		)
	setTimeout(() => cancel.abort(), 150)
	await expect(pending).rejects.toThrow(/cancel/i)
	expect(
		(await host.request('eg.get', { ...request(), target: eventGridTopic('orders') })).name,
	).toBe('orders')
})
it('expires sessions and cursors after disconnect', async () => {
	await start()
	await host.request('eg.disconnect', request())
	await expect(
		host.request('eg.list', {
			...request(),
			target: eventGridNamespace,
			continuationToken: null,
		}),
	).rejects.toThrow(/expired/)
})
it('rejects mismatched profiles and invalid paths before contacting the backend', async () => {
	const controller = new EventGridController(
		{
			request: () => {
				throw new Error('Network should not run')
			},
		} as unknown as Backend,
		() => {},
	)
	const value = profile()
	await expect(
		controller.connect(
			{ ...setup(), profileId: value.id },
			{ ...value, namespace: 'other.westeurope-1.eventgrid.azure.net', secretState: 'none' },
			new AbortController().signal,
		),
	).rejects.toThrow(/matching/)
})
it('uses metadata only for Entra connections and refuses stale reads after reset', async () => {
	await start()
	const controller = new EventGridController(host, () => {}),
		value = profile(),
		signal = new AbortController().signal
	const connection = await controller.connect(
		{ ...setup(), profileId: value.id },
		{ ...value, secretState: 'none' },
		signal,
	)
	const pending = controller.get(
		{ id: randomUUID(), connectionId: connection.connectionId, target: eventGridTopic('slow') },
		signal,
	)
	const reset = controller.reset()
	await expect(pending).rejects.toThrow(/cancel/i)
	await reset
}, 15000)
it('cancels device-code connection without leaving a usable backend session', async () => {
	host = new Backend('dotnet', [dll])
	await host.start()
	const cancel = new AbortController(),
		value = profile()
	const code = new Promise<void>((resolve) =>
		host.on('event', (e) => {
			if (e.type === 'device-code') resolve()
		}),
	)
	const pending = host.request(
		'eg.connect',
		{
			operationId: randomUUID(),
			profile: value,
			management: { resourceId, tenantId: 'slow', clientId: value.clientId },
		},
		{ signal: cancel.signal },
	)
	await code
	cancel.abort()
	await expect(pending).rejects.toThrow(/cancel/i)
	await host.request('eg.reset', {})
})

it('refuses repeated upstream continuations without invalidating the current page', async () => {
	await start('repeat')
	const value = { ...request(), target: eventGridNamespace, continuationToken: null }
	const first = await host.request('eg.list', value)
	await expect(
		host.request('eg.list', {
			...value,
			id: randomUUID(),
			continuationToken: first.continuationToken,
		}),
	).rejects.toThrow(/repeated/)
	expect((await host.request('eg.list', { ...value, id: randomUUID() })).items[0].name).toBe(
		'orders',
	)
})
it('disposes a late connection result after a main-process reset', async () => {
	const value = profile(),
		connectionId = randomUUID()
	let finish!: (value: unknown) => void
	const calls: string[] = []
	const backend = {
		status: { state: 'ready' },
		request: async (method: string) => {
			calls.push(method)
			if (method === 'eg.connect')
				return new Promise((resolve) => {
					finish = resolve
				})
			return null
		},
	} as unknown as Backend
	const controller = new EventGridController(backend, () => {})
	const pending = controller.connect(
		{ ...setup(), profileId: value.id },
		{ ...value, secretState: 'none' },
		new AbortController().signal,
	)
	await new Promise((resolve) => setTimeout(resolve, 0))
	await controller.reset()
	finish({ connectionId })
	await expect(pending).rejects.toThrow(/cancel/i)
	expect(calls).toEqual(['eg.connect', 'eg.reset', 'eg.disconnect'])
	expect(() => controller.require(connectionId)).toThrow(/again/)
})
