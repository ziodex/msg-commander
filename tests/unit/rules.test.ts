import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	defaultRule,
	emptyCorrelation,
	rulePath,
	type RuleDefinition,
	type RuleConfiguration,
	type SubscriptionTarget,
} from '../../src/shared/rules'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const target: SubscriptionTarget = {
	kind: 'subscription',
	topicName: 'order-events',
	name: 'billing',
}
let host: Backend, connectionId: string
afterEach(async () => {
	await host?.stop()
})
const request = () => ({ id: randomUUID(), connectionId, target })
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
	connectionId = (
		await host.request('sb.connect', {
			operationId: randomUUID(),
			profile: {
				id: randomUUID(),
				name: 'Offline',
				service: 'service-bus',
				namespace: 'fixture.servicebus.windows.net',
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
}
const get = (name = '$Default') => host.request('sb.rule', { ...request(), name })
const create = (name: string, definition = defaultRule()) =>
	host.request('sb.rule.create', { ...request(), name, definition })
const update = (rule: RuleConfiguration, definition: RuleDefinition) =>
	host.request('sb.rule.update', {
		...request(),
		name: rule.name,
		definition,
		expectedRevision: rule.revision,
	})
const remove = (rule: RuleConfiguration, confirmation = rulePath(target, rule.name)) =>
	host.request('sb.rule.delete', {
		...request(),
		name: rule.name,
		expectedRevision: rule.revision,
		confirmation,
	})

it('uses actual SDK HTTP serialization for SQL/correlation filters, actions, typed values and safe direct updates', () => {
	expect(execFileSync('dotnet', [dll, '--rule-checks'], { encoding: 'utf8' })).toContain(
		'Rule adapter checks passed',
	)
})
it('creates and edits SQL parameters/actions, removes an action, and keeps the default until explicitly deleted', async () => {
	await start()
	const definition = {
		...defaultRule(),
		sqlExpression: 'user.total > @min',
		filterParameters: [{ name: '@min', type: 'int64', value: '9007199254740993' }],
		actionExpression: 'SET user.route = @route; REMOVE user.secret;',
		actionParameters: [{ name: '@route', type: 'string', value: 'Málaga 🚀' }],
	}
	expect((await create('priority', definition)).status).toBe('confirmed')
	expect((await get('priority')).definition).toEqual(definition)
	expect((await get()).definition.filterType).toBe('true')
	const plain = { ...definition, actionExpression: '', actionParameters: [] }
	expect((await update(await get('priority'), plain)).status).toBe('confirmed')
	expect((await get('priority')).definition.actionExpression).toBe('')
	expect((await remove(await get(), '$Default')).status).toBe('rejected')
	expect((await remove(await get())).status).toBe('confirmed')
	await expect(get()).rejects.toMatchObject({ code: '-32004' })
	expect((await get('priority')).definition).toEqual(plain)
})
it('round-trips correlation headers/properties and permits actions and filter type changes', async () => {
	await start()
	const correlation = {
		...emptyCorrelation(),
		correlationId: 'Correlation-A',
		subject: 'Blue',
		properties: [
			{ name: 'active', type: 'boolean', value: 'true' },
			{ name: 'age', type: 'timespan', value: '00:05:00' },
			{ name: 'created', type: 'datetime', value: '2026-10-10T10:00:00Z' },
		],
	}
	const definition: RuleDefinition = {
		...defaultRule(),
		filterType: 'correlation',
		sqlExpression: '',
		correlation,
		actionExpression: "SET user.route = 'blue';",
	}
	expect((await create('correlated', definition)).status).toBe('confirmed')
	expect((await get('correlated')).definition).toEqual(definition)
	expect(
		(
			await update(await get('correlated'), {
				...defaultRule(),
				filterType: 'false',
				sqlExpression: '',
			})
		).status,
	).toBe('confirmed')
	expect((await get('correlated')).definition.filterType).toBe('false')
})
it('rejects invalid names, mismatched definitions, duplicate keys, lossy types and known broker failures', async () => {
	await start()
	for (const name of ['../bad', 'a/b', 'a?b', 'x'.repeat(51)])
		expect((await create(name)).status).toBe('rejected')
	const invalid: RuleDefinition[] = [
		{ ...defaultRule(), sqlExpression: '' },
		{ ...defaultRule(), sqlExpression: 'x'.repeat(1025) },
		{
			...defaultRule(),
			filterType: 'correlation',
			sqlExpression: '',
			correlation: emptyCorrelation(),
		},
		{ ...defaultRule(), correlation: emptyCorrelation() },
		{
			...defaultRule(),
			filterParameters: [{ name: '@x', type: 'int64', value: '9223372036854775808' }],
		},
		{ ...defaultRule(), filterParameters: [{ name: '@x', type: 'double', value: 'NaN' }] },
		{ ...defaultRule(), filterParameters: [{ name: '@x', type: 'decimal', value: '1.2' }] },
		{
			...defaultRule(),
			filterParameters: [
				{ name: '@x', type: 'string', value: 'a' },
				{ name: '@x', type: 'string', value: 'b' },
			],
		},
		{ ...defaultRule(), actionParameters: [{ name: '@x', type: 'boolean', value: 'true' }] },
		{
			...defaultRule(),
			filterType: 'correlation',
			sqlExpression: '',
			correlation: { ...emptyCorrelation(), subject: ' ' },
		},
		{ ...defaultRule(), sqlExpression: 'INVALID SQL' },
	]
	for (const definition of invalid)
		expect((await create('invalid-rule', definition)).status).toBe('rejected')
	expect((await create('$Default')).status).toBe('rejected')
	const denied = await create('denied-rule')
	expect(denied.status).toBe('rejected')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
	expect(
		(
			await host.request('sb.rule.create', {
				...request(),
				target: { ...target, name: 'missing' },
				name: 'rule',
				definition: defaultRule(),
			})
		).status,
	).toBe('rejected')
	expect(
		(
			await host.request('sb.rule.create', {
				...request(),
				target: { kind: 'queue', name: 'orders' } as unknown as SubscriptionTarget,
				name: 'rule',
				definition: defaultRule(),
			})
		).status,
	).toBe('rejected')
})
it('checks stale edits/deletes, paginates, and scopes rules to their parent subscription', async () => {
	await start()
	const first = await get()
	await update(first, defaultRule())
	expect((await update(first, defaultRule())).summary).toContain('changed since')
	expect((await remove(first)).status).toBe('rejected')
	await create('one')
	await create('two')
	const firstPage = await host.request('sb.rules', request())
	expect(firstPage.items).toHaveLength(2)
	const secondPage = await host.request('sb.rules', {
		...request(),
		continuationToken: firstPage.continuationToken,
	})
	expect(secondPage.items).toHaveLength(1)
	expect(secondPage.continuationToken).toBeNull()
	expect(
		(
			await host.request('sb.rule', {
				...request(),
				target: { ...target, name: 'audit' },
				name: '$Default',
			})
		).definition.filterType,
	).toBe('true')
	await host.request('sb.reset', {})
	await expect(get()).rejects.toMatchObject({ code: '-32010' })
})
it('retains independent message locks and snapshots while changing only future routing', async () => {
	await start()
	const peek = await host.request('sb.peek', {
		...request(),
		subQueue: 'active',
		fromSequenceNumber: '0',
		maxMessages: 1,
	})
	const held = await host.request('sb.receive', {
		...request(),
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	expect((await remove(await get())).status).toBe('confirmed')
	expect((await host.request('sb.deliveries', request())).items[0].deliveryId).toBe(
		held.items[0].deliveryId,
	)
	expect(
		(await host.request('sb.inspect', { ...request(), snapshotId: peek.items[0].snapshotId! }))
			.summary.sequenceNumber,
	).toBe(peek.items[0].sequenceNumber)
})
it('records ambiguous create/update/delete and deduplicates receipt IDs without replaying writes', async () => {
	await start()
	const input = { ...request(), name: 'unknown-rule', definition: defaultRule() }
	const result = await host.request('sb.rule.create', input)
	expect(result.status).toBe('unknown')
	expect(await host.request('sb.rule.create', input)).toEqual(result)
	await expect(
		host.request('sb.rule.create', { ...input, name: 'different' }),
	).rejects.toMatchObject({ code: '-32602' })
	expect(await host.request('sb.outcome', { ...request(), operationId: input.id })).toEqual(
		result,
	)
	expect(
		(
			await update(await get('unknown-rule'), {
				...defaultRule(),
				actionExpression: "SET outcome = 'unknown'",
			})
		).status,
	).toBe('unknown')
	expect((await remove(await get('unknown-rule'))).status).toBe('unknown')
	await expect(get('unknown-rule')).rejects.toMatchObject({ code: '-32004' })
})
it('keeps truthful rule receipts across cancellation before dispatch, after dispatch and after acknowledgement', async () => {
	await start()
	for (const [name, definition, expected] of [
		[
			'preflight',
			{ ...defaultRule(), actionExpression: "SET slow = 'preflight'" },
			'cancelled',
		],
		['slow-rule', defaultRule(), 'unknown'],
		['commit-late-rule', defaultRule(), 'confirmed'],
	] as const) {
		const input = { ...request(), name, definition }
		const controller = new AbortController()
		const pending = host.request('sb.rule.create', input, { signal: controller.signal })
		setTimeout(() => controller.abort(), 50)
		await pending.catch(() => undefined)
		const receipt = await host.request('sb.outcome', { ...request(), operationId: input.id })
		expect(receipt?.status).toBe(expected)
	}
})
