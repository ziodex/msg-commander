import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import {
	authorizationConfirmation,
	authorizationContextSchema,
	authorizationRightsSchema,
	type AuthorizationTarget,
	type AuthorizationRule,
	type AuthorizationKeyType,
} from '../../src/shared/authorization'

const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ServiceBus/namespaces/fixture'
const context = {
	resourceId,
	tenantId: 'fixture',
	clientId: '22222222-2222-4222-8222-222222222222',
}
let host: Backend, connectionId: string, authorizationId: string
const namespace: AuthorizationTarget = { kind: 'namespace' }
const request = (target: AuthorizationTarget = namespace) => ({
	id: randomUUID(),
	connectionId,
	authorizationId,
	target,
})
afterEach(async () => {
	await host?.stop()
})
async function start(authorize = true) {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				namespace: 'fixture.servicebus.windows.net',
				service: 'service-bus',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
	if (authorize)
		authorizationId = (
			await host.request('sb.authorization.connect', {
				id: randomUUID(),
				connectionId,
				context,
			})
		).authorizationId
}
const create = (
	name: string,
	target: AuthorizationTarget = namespace,
	rights: ('Send' | 'Listen' | 'Manage')[] = ['Send'],
) => host.request('sb.authorization.create', { ...request(target), name, rights })
const get = (name: string, target: AuthorizationTarget = namespace) =>
	host.request('sb.authorization.get', { ...request(target), name })
const key = (
	name: string,
	keyType: AuthorizationKeyType = 'PrimaryKey',
	target: AuthorizationTarget = namespace,
) => host.request('sb.authorization.key', { ...request(target), name, keyType })
function rotation(
	rule: AuthorizationRule,
	keyType: AuthorizationKeyType = 'PrimaryKey',
	target: AuthorizationTarget = namespace,
) {
	return {
		...request(target),
		name: rule.name,
		expectedRevision: rule.revision,
		keyType,
		confirmation: authorizationConfirmation(
			'regenerate',
			resourceId,
			target,
			rule.name,
			keyType,
		),
	}
}
it('exercises real ARM SDK routes, rights payloads, paging and independent key slots', () => {
	expect(execFileSync('dotnet', [dll, '--authorization-checks'], { encoding: 'utf8' })).toContain(
		'Authorization adapter checks passed',
	)
})
it('lists direct policies at each scope without exposing keys', async () => {
	await start()
	for (const [target, expected] of [
		[namespace, 'RootManageSharedAccessKey'],
		[{ kind: 'queue', name: 'orders' }, 'sender'],
		[{ kind: 'topic', name: 'order-events' }, 'subscriber'],
	] as const) {
		const result = await host.request('sb.authorization.list', request(target))
		expect(result.items.map((r) => r.name)).toEqual([expected])
		expect(JSON.stringify(result)).not.toMatch(
			/fixture-primary|fixture-secondary|ConnectionString/,
		)
	}
})
it('creates, edits and deletes rules while preserving other scopes and keys', async () => {
	await start()
	const target: AuthorizationTarget = { kind: 'queue', name: 'orders' }
	expect((await create('client', target)).status).toBe('confirmed')
	const before = await get('client', target),
		oldKey = await key('client', 'PrimaryKey', target)
	expect(
		(
			await host.request('sb.authorization.update', {
				...request(target),
				name: 'client',
				rights: ['Listen', 'Send', 'Manage'],
				expectedRevision: before.revision,
				confirmation: authorizationConfirmation('update', resourceId, target, 'client'),
			})
		).status,
	).toBe('confirmed')
	expect(await key('client', 'PrimaryKey', target)).toEqual(oldKey)
	const changed = await get('client', target)
	expect(changed.rights).toEqual(['Listen', 'Manage', 'Send'])
	expect(
		(
			await host.request('sb.authorization.delete', {
				...request(target),
				name: 'client',
				expectedRevision: changed.revision,
				confirmation: authorizationConfirmation('delete', resourceId, target, 'client'),
			})
		).status,
	).toBe('confirmed')
	await expect(get('client', target)).rejects.toMatchObject({ code: '-32004' })
	expect((await get('sender', target)).rights).toEqual(['Send'])
	expect((await get('RootManageSharedAccessKey')).rights).toContain('Manage')
})
it('regenerates one slot per confirmed request and never exposes keys in receipts or events', async () => {
	await start()
	await create('client')
	const events: unknown[] = []
	host.on('event', (value) => events.push(value))
	const before = await key('client'),
		secondary = await key('client', 'SecondaryKey')
	const first = rotation(await get('client'))
	const result = await host.request('sb.authorization.regenerate', first)
	expect(result.status).toBe('confirmed')
	expect((await key('client')).key).not.toEqual(before.key)
	expect(await key('client', 'SecondaryKey')).toEqual(secondary)
	expect(await host.request('sb.authorization.regenerate', first)).toEqual(result)
	expect((await key('client')).key).toBe('fixture-primary-rotated-1')
	const receipt = await host.request('sb.outcome', {
		id: randomUUID(),
		connectionId,
		operationId: first.id,
	})
	expect(receipt).toEqual(result)
	expect(JSON.stringify({ events, receipt })).not.toMatch(
		/fixture-primary|fixture-secondary|SharedAccessKey=/,
	)
	await host.request('sb.authorization.regenerate', rotation(await get('client'), 'SecondaryKey'))
	expect((await key('client', 'SecondaryKey')).key).toBe('fixture-secondary-rotated-2')
	expect((await key('client')).key).toBe('fixture-primary-rotated-1')
})
it('rejects wrong confirmation, stale rights, duplicate creates and invalid permission sets', async () => {
	await start()
	await create('client')
	expect((await create('client')).status).toBe('rejected')
	for (const rights of [[], ['Manage'], ['Send', 'Send'], ['Owner']] as unknown as (
		'Send' | 'Listen' | 'Manage'
	)[][])
		expect((await create('invalid', namespace, rights)).status).toBe('rejected')
	const first = await get('client')
	expect(
		(
			await host.request('sb.authorization.regenerate', {
				...rotation(first),
				confirmation: 'client',
			})
		).status,
	).toBe('rejected')
	expect(
		(
			await host.request('sb.authorization.regenerate', {
				...rotation(first),
				keyType: 'SecondaryKey',
			})
		).status,
	).toBe('rejected')
	await host.request('sb.authorization.update', {
		...request(),
		name: 'client',
		rights: ['Listen'],
		expectedRevision: first.revision,
		confirmation: authorizationConfirmation('update', resourceId, namespace, 'client'),
	})
	expect((await host.request('sb.authorization.regenerate', rotation(first))).status).toBe(
		'rejected',
	)
	expect((await key('client')).key).toBe('fixture-primary-secret')
})
it('redacts permission errors and keeps ambiguous or throttled rotations uncertain without retry', async () => {
	await start()
	const denied = await create('denied')
	expect(denied.status).toBe('rejected')
	expect(denied.summary).toContain('Azure Resource Manager')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
	for (const name of ['uncertain', 'throttled']) {
		await create(name)
		const command = rotation(await get(name))
		const result = await host.request('sb.authorization.regenerate', command)
		expect(result.status).toBe('unknown')
		expect(JSON.stringify(result)).not.toContain('SECRET')
		const value = (await key(name)).key
		expect(await host.request('sb.authorization.regenerate', command)).toEqual(result)
		expect((await key(name)).key).toBe(value)
		await expect(
			host.request('sb.authorization.regenerate', { ...command, keyType: 'SecondaryKey' }),
		).rejects.toMatchObject({ code: '-32602' })
	}
})
it('retains an uncertain receipt when cancellation follows a dispatched rotation', async () => {
	await start()
	await create('slow')
	const command = rotation(await get('slow')),
		controller = new AbortController()
	const pending = host.request('sb.authorization.regenerate', command, {
		signal: controller.signal,
	})
	await new Promise((resolve) => setTimeout(resolve, 150))
	controller.abort()
	await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
	const result = await host.request('sb.outcome', {
		id: randomUUID(),
		connectionId,
		operationId: command.id,
	})
	expect(result?.status).toBe('unknown')
	expect((await key('slow')).key).toBe('fixture-primary-rotated-1')
})
it('requires matching ARM context and invalidates authorization sessions on reconnect/reset', async () => {
	await start(false)
	await expect(host.request('sb.authorization.list', request())).rejects.toBeDefined()
	await expect(
		host.request('sb.authorization.connect', {
			id: randomUUID(),
			connectionId,
			context: {
				...context,
				resourceId: resourceId.replace('/namespaces/fixture', '/namespaces/another'),
			},
		}),
	).rejects.toMatchObject({ code: '-32602' })
	await expect(
		host.request('sb.authorization.connect', {
			id: randomUUID(),
			connectionId,
			context: { ...context, tenantId: 'denied' },
		}),
	).rejects.toMatchObject({ code: '-32001' })
	authorizationId = (
		await host.request('sb.authorization.connect', { id: randomUUID(), connectionId, context })
	).authorizationId
	const old = request()
	await host.request('sb.authorization.connect', { id: randomUUID(), connectionId, context })
	await expect(host.request('sb.authorization.list', old)).rejects.toMatchObject({
		code: '-32010',
	})
	await host.request('sb.reset', {})
	await expect(host.request('sb.authorization.list', old)).rejects.toMatchObject({
		code: '-32010',
	})
})
it('validates context URLs, scope paths, key slots and names before mutation', async () => {
	expect(authorizationContextSchema.safeParse(context).success).toBe(true)
	expect(
		authorizationContextSchema.safeParse({ ...context, resourceId: 'https://evil.test' })
			.success,
	).toBe(false)
	expect(authorizationRightsSchema.safeParse(['Manage']).success).toBe(false)
	await start()
	for (const name of ['../bad', 'a/b', 'a?b', 'x'.repeat(51)])
		expect((await create(name)).status).toBe('rejected')
	for (const target of [
		{ kind: 'subscription', name: 'billing' },
		{ kind: 'queue', name: '../other' },
		{ kind: 'namespace', name: 'other' },
	])
		expect((await create('bad', target as AuthorizationTarget)).status).toBe('rejected')
	const command = rotation(await get('RootManageSharedAccessKey'))
	expect(
		(
			await host.request('sb.authorization.regenerate', {
				...command,
				keyType: 'BothKeys' as AuthorizationKeyType,
			})
		).status,
	).toBe('rejected')
})

it('routes renewed management sign-in prompts to the current operation', async () => {
	await start()
	await create('reauth')
	const events: unknown[] = []
	host.on('event', (event) => events.push(event))
	const command = { ...request(), name: 'reauth' }
	await host.request('sb.authorization.get', command)
	expect(events).toContainEqual(
		expect.objectContaining({
			type: 'device-code',
			operationId: command.id,
			code: 'OFFLINE-REFRESH',
		}),
	)
})
