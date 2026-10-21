import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { EventGridController } from '../../src/main/features/event-grid/controller'
import {
	eventGridAdminChangeSchema,
	type EventGridAdminChange,
	type EventGridSubscriptionSettings,
} from '../../src/shared/contracts/event-grid/administration'
import { eventGridTopic } from '../../src/shared/contracts/event-grid/core'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
let host: Backend,
	connectionId: string = randomUUID()
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
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	const p = profile()
	connectionId = (
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile: p,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		})
	).connectionId
}
const request = () => ({ id: randomUUID(), connectionId })
const change = (name = 'new-topic'): EventGridAdminChange => ({
	...request(),
	target: eventGridTopic(name),
	action: 'create',
	expectedRevision: null,
	retentionDays: 7,
	settings: null,
	destination: null,
	acknowledged: true,
	confirmation: null,
})
const settings: EventGridSubscriptionSettings = {
	deliveryMode: 'Queue',
	receiveLockDurationInSeconds: 60,
	maxDeliveryCount: 10,
	eventTimeToLive: 'P1D',
	expirationTimeUtc: null,
	includedEventTypes: null,
	filters: [],
}
afterEach(async () => {
	await host?.stop()
})
it('exercises production ARM CRUD, all 19 filters, precision, preservation, scope and truthful acknowledgments', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-grid-admin-checks'], { encoding: 'utf8' }),
	).toContain('Event Grid administration adapter checks passed')
})
it('bounds the named mutation contract and requires exact deletion review', () => {
	const v = change()
	expect(eventGridAdminChangeSchema.safeParse(v).success).toBe(true)
	for (const patch of [
		{ url: 'https://evil.invalid' },
		{ acknowledged: false },
		{ retentionDays: 8 },
		{ expectedRevision: 'A'.repeat(64) },
		{ target: { kind: 'namespace', topicName: null, subscriptionName: null } },
		{
			destination: {
				endpointType: 'WebHook',
				endpointUrl: 'https://example.invalid',
				resourceId: null,
				queueName: null,
			},
		},
	])
		expect(eventGridAdminChangeSchema.safeParse({ ...v, ...patch }).success).toBe(false)
	const deletion = {
		...v,
		action: 'delete',
		retentionDays: null,
		expectedRevision: 'A'.repeat(64),
		confirmation: 'new-topic',
	}
	expect(eventGridAdminChangeSchema.safeParse(deletion).success).toBe(true)
	expect(
		eventGridAdminChangeSchema.safeParse({ ...deletion, confirmation: 'wrong' }).success,
	).toBe(false)
})
it('creates, edits and deletes topics, retaining receipts without replaying writes', async () => {
	await start()
	const v = change()
	const result = await host.request('eg.admin.change', v)
	expect(result.status).toBe('confirmed')
	expect(await host.request('eg.admin.change', v)).toEqual(result)
	await expect(host.request('eg.admin.change', { ...v, retentionDays: 3 })).rejects.toThrow(
		/operation ID/,
	)
	expect(await host.request('eg.admin.result', { ...request(), operationId: v.id })).toEqual(
		result,
	)
	const read = await host.request('eg.admin.get', { ...request(), target: v.target })
	const edit = await host.request('eg.admin.change', {
		...v,
		...request(),
		action: 'update',
		expectedRevision: read.revision,
		retentionDays: 3,
	})
	expect(edit.status).toBe('confirmed')
	const stale = await host.request('eg.admin.change', {
		...v,
		...request(),
		action: 'update',
		expectedRevision: read.revision,
		retentionDays: 2,
	})
	expect(stale.status).toBe('failed')
	expect(stale.summary).toContain('changed since review')
	const fresh = await host.request('eg.admin.get', { ...request(), target: v.target })
	expect(
		(
			await host.request('eg.admin.change', {
				...v,
				...request(),
				action: 'delete',
				expectedRevision: fresh.revision,
				retentionDays: null,
				confirmation: 'new-topic',
			})
		).status,
	).toBe('confirmed')
	await expect(host.request('eg.get', { ...request(), target: v.target })).rejects.toThrow()
})
it('creates subscriptions with event types and filters and keeps unknown Push settings private during edits', async () => {
	await start()
	const v = {
		...change(),
		target: { kind: 'subscription' as const, topicName: 'orders', subscriptionName: 'new-sub' },
		retentionDays: null,
		settings: {
			...settings,
			includedEventTypes: ['Order.Created'],
			filters: [
				{
					key: 'data.total',
					operatorType: 'NumberGreaterThan' as const,
					operandJson: '9007199254740993',
				},
			],
		},
	}
	expect((await host.request('eg.admin.change', v)).status).toBe('confirmed')
	const read = await host.request('eg.admin.get', { ...request(), target: v.target })
	expect(read.settings?.filters?.[0].operandJson).toBe('9007199254740993')
	const target = { ...v.target, subscriptionName: 'audit' },
		audit = await host.request('eg.admin.get', { ...request(), target })
	expect(audit.settings?.filters).toBeNull()
	expect(JSON.stringify(audit)).not.toContain('SECRET')
	expect(
		(
			await host.request('eg.admin.change', {
				...v,
				...request(),
				target,
				action: 'update',
				expectedRevision: audit.revision,
				settings: { ...audit.settings!, includedEventTypes: ['Order.Paid'] },
			})
		).status,
	).toBe('confirmed')
	const inspect = await host.request('eg.get', { ...request(), target })
	expect(inspect.filters?.includedEventTypes).toEqual(['Order.Paid'])
	expect(inspect.filters?.filters[0].operatorType).toBe('FutureOperator')
	expect(JSON.stringify(inspect)).not.toContain('SECRET')
})
it('reports lost responses as unknown and recovers the same immutable receipt', async () => {
	await start()
	const v = change('write-lost'),
		result = await host.request('eg.admin.change', v)
	expect(result.status).toBe('unknown')
	expect(result.summary).not.toContain('SECRET')
	expect((await host.request('eg.get', { ...request(), target: v.target })).name).toBe(
		'write-lost',
	)
	expect(await host.request('eg.admin.result', { ...request(), operationId: v.id })).toEqual(
		result,
	)
	expect(await host.request('eg.admin.change', v)).toEqual(result)
})
it('distinguishes acceptance from completion and rejects edits while provisioning', async () => {
	await start()
	const v = change('write-accepted'),
		result = await host.request('eg.admin.change', v)
	expect(result.status).toBe('accepted')
	const read = await host.request('eg.admin.get', { ...request(), target: v.target })
	const edit = await host.request('eg.admin.change', {
		...v,
		...request(),
		action: 'update',
		expectedRevision: read.revision,
		retentionDays: 3,
	})
	expect(edit.status).toBe('failed')
	expect(edit.summary).toContain('still provisioning')
})
it('retains an unknown receipt when cancellation follows dispatch', async () => {
	await start()
	const v = change('write-slow'),
		cancel = new AbortController(),
		pending = host.request('eg.admin.change', v, {
			signal: cancel.signal,
			waitForCancellation: true,
		})
	setTimeout(() => cancel.abort(), 150)
	const result = await pending
	expect(result.status).toBe('unknown')
	expect(await host.request('eg.admin.result', { ...request(), operationId: v.id })).toEqual(
		result,
	)
})
it('sanitizes write denials and rejects invalid filters before a write', async () => {
	await start()
	const result = await host.request('eg.admin.change', change('write-denied'))
	expect(result.status).toBe('failed')
	expect(result.summary).toContain('permissions')
	expect(result.summary).not.toContain('SECRET')
	await expect(
		host.request('eg.admin.change', {
			...change(),
			target: { kind: 'subscription', topicName: 'orders', subscriptionName: 'bad-filter' },
			retentionDays: null,
			settings: {
				...settings,
				filters: [{ key: 'data.x', operatorType: 'NumberIn', operandJson: '["wrong"]' }],
			},
		}),
	).rejects.toThrow(/filter/)
})
it('returns cancellation before dispatch and expires receipts on reconnect', async () => {
	await start()
	const read = await host.request('eg.admin.get', {
			...request(),
			target: eventGridTopic('slow'),
		}),
		cancel = new AbortController(),
		v = { ...change('slow'), action: 'update' as const, expectedRevision: read.revision }
	const pending = host.request('eg.admin.change', v, {
		signal: cancel.signal,
		waitForCancellation: true,
	})
	setTimeout(() => cancel.abort(), 100)
	expect((await pending).status).toBe('cancelled')
	await host.request('eg.reset', {})
	await expect(
		host.request('eg.admin.result', { ...request(), operationId: v.id }),
	).rejects.toThrow(/expired/)
}, 15000)
it('controller preserves an acknowledgment after abort and requires the active connection', async () => {
	let complete!: (value: unknown) => void
	const calls: { method: string; wait?: boolean }[] = [],
		p = profile(),
		id = randomUUID()
	const backend = {
		status: { state: 'ready' },
		request: async (
			method: string,
			_value: unknown,
			options?: { waitForCancellation?: boolean },
		) => {
			calls.push({ method, wait: options?.waitForCancellation })
			if (method === 'eg.connect') return { connectionId: id }
			if (method === 'eg.admin.change')
				return new Promise((resolve) => {
					complete = resolve
				})
			return null
		},
	} as unknown as Backend
	const controller = new EventGridController(backend, () => {}),
		cancel = new AbortController()
	await controller.connect(
		{
			id: randomUUID(),
			profileId: p.id,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		},
		{ ...p, secretState: 'none' },
		cancel.signal,
	)
	const value = { ...change(), connectionId: id },
		pending = controller.change(value, cancel.signal)
	cancel.abort()
	complete({ status: 'confirmed' })
	expect(await pending).toEqual({ status: 'confirmed' })
	expect(calls.at(-1)?.wait).toBe(true)
	await expect(
		controller.change({ ...value, connectionId: randomUUID() }, new AbortController().signal),
	).rejects.toThrow(/again/)
})
