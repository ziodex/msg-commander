import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	defaultEntitySettings,
	entityPath,
	type EntitySettings,
} from '../../src/shared/entity-management'
import {
	defaultRule,
	emptyCorrelation,
	rulePath,
	type RuleDefinition,
	type SubscriptionTarget,
} from '../../src/shared/rules'
import {
	entityCopyConfirmation,
	entityCopySpecSchema,
	type EntityCopySpec,
	type EntityCopyPreview,
} from '../../src/shared/entity-copy'
import type { EntityTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const namespace = 'fixture.servicebus.windows.net'
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
const queue = (name: string): Extract<EntityTarget, { kind: 'queue' }> => ({ kind: 'queue', name })
const topic = (name: string): Extract<EntityTarget, { kind: 'topic' }> => ({ kind: 'topic', name })
const sub = (name: string, topicName: string): SubscriptionTarget => ({
	kind: 'subscription',
	name,
	topicName,
})
afterEach(async () => {
	await host?.stop()
})
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
				namespace,
				auth: 'sas',
				tenantId: '',
				clientId: '',
				secret: 'fixture',
				rememberSecret: false,
			},
		})
	).connectionId
}
const config = (target: EntityTarget) => host.request('sb.entity-config', { ...request(), target })
async function create(target: EntityTarget, patch: Partial<EntitySettings> = {}) {
	expect(
		(
			await host.request('sb.entity.create', {
				...request(),
				target,
				settings: { ...defaultEntitySettings(target.kind), ...patch },
			})
		).status,
	).toBe('confirmed')
}
async function update(target: EntityTarget, patch: Partial<EntitySettings>) {
	const current = await config(target)
	expect(
		(
			await host.request('sb.entity.update', {
				...request(),
				target,
				expectedRevision: current.revision,
				settings: { ...current.settings, ...patch },
			})
		).status,
	).toBe('confirmed')
}
async function remove(target: EntityTarget) {
	const current = await config(target)
	return host.request('sb.entity.delete', {
		...request(),
		target,
		expectedRevision: current.revision,
		confirmation: entityPath(target),
	})
}
function spec(
	source: EntityTarget,
	destination: EntityTarget,
	mode: 'duplicate' | 'rename' = 'duplicate',
	includeSubscriptions = source.kind === 'topic',
): EntityCopySpec {
	return { source, destination, mode, includeSubscriptions }
}
const preview = (value: EntityCopySpec) =>
	host.request('sb.entity.copy.preview', { ...request(), spec: value })
const execution = (plan: EntityCopyPreview) => ({
	...request(),
	planId: plan.planId,
	confirmation: entityCopyConfirmation(namespace, plan.spec),
})
const execute = (plan: EntityCopyPreview) => host.request('sb.entity.copy.execute', execution(plan))
const review = (operationId: string) =>
	host.request('sb.entity.rename.review', { ...request(), operationId })
const rule = (target: SubscriptionTarget, name: string) =>
	host.request('sb.rule', { ...request(), target, name })
async function addRule(
	target: SubscriptionTarget,
	name: string,
	definition: RuleDefinition = defaultRule(),
) {
	expect(
		(await host.request('sb.rule.create', { ...request(), target, name, definition })).status,
	).toBe('confirmed')
}
async function removeDefault(target: SubscriptionTarget) {
	const current = await rule(target, '$Default')
	expect(
		(
			await host.request('sb.rule.delete', {
				...request(),
				target,
				name: current.name,
				expectedRevision: current.revision,
				confirmation: rulePath(target, current.name),
			})
		).status,
	).toBe('confirmed')
}

it('uses the real Azure SDK to copy all supported fields, exclude credentials and atomically create a false subscription guard', () => {
	expect(execFileSync('dotnet', [dll, '--copy-checks'], { encoding: 'utf8' })).toContain(
		'Copy adapter checks passed',
	)
})
it('copies queue creation-only settings, preserves forwarding paths and retains source messages', async () => {
	await start()
	const source = queue('copy-original'),
		destination = queue('copy-destination')
	await create(source, {
		requiresSession: true,
		enablePartitioning: true,
		requiresDuplicateDetection: true,
		forwardTo: 'archive',
		userMetadata: 'Málaga 🚀',
		maxDeliveryCount: 42,
	})
	const before = await config(source),
		plan = await preview(spec(source, destination))
	expect(plan.entities[0].settings).toEqual(before.settings)
	const result = await execute(plan)
	expect(result.status).toBe('confirmed')
	expect(result.steps).toHaveLength(plan.stepCount)
	expect((await config(destination)).settings).toEqual(before.settings)
	expect(await config(source)).toEqual(before)
	const ordersCopy = await execute(await preview(spec(queue('orders'), queue('copy-orders'))))
	expect(ordersCopy.status).toBe('confirmed')
	expect(
		(
			await host.request('sb.peek', {
				...request(),
				target: queue('copy-orders'),
				subQueue: 'active',
				fromSequenceNumber: '0',
				maxMessages: 10,
			})
		).items,
	).toHaveLength(0)
	expect(
		(
			await host.request('sb.peek', {
				...request(),
				target: queue('orders'),
				subQueue: 'active',
				fromSequenceNumber: '0',
				maxMessages: 10,
			})
		).items.length,
	).toBeGreaterThan(0)
})
it('copies paginated subscriptions and SQL/correlation rules, actions and exact typed values; preserves empty rule sets', async () => {
	await start()
	const source = topic('copy-events'),
		destination = topic('copy-events-new')
	await create(source, { supportOrdering: true })
	const billing = sub('billing', source.name)
	for (const name of ['billing', 'audit', 'empty']) await create(sub(name, source.name))
	const sql: RuleDefinition = {
		...defaultRule(),
		sqlExpression: 'user.total > @min',
		filterParameters: [{ name: '@min', type: 'int64', value: '9007199254740993' }],
		actionExpression: 'SET user.route = @route;',
		actionParameters: [{ name: '@route', type: 'string', value: 'Málaga' }],
	}
	const correlation: RuleDefinition = {
		...defaultRule(),
		filterType: 'correlation',
		sqlExpression: '',
		correlation: {
			...emptyCorrelation(),
			subject: 'Blue',
			properties: [{ name: 'exact', type: 'int64', value: '9007199254740993' }],
		},
		actionExpression: "SET user.route = 'blue';",
	}
	await addRule(billing, 'sql', sql)
	await addRule(billing, 'correlation', correlation)
	await removeDefault(sub('empty', source.name))
	const plan = await preview(spec(source, destination, 'rename'))
	expect(plan.entities).toHaveLength(4)
	expect(plan.entities.flatMap((e) => e.rules)).toHaveLength(4)
	const result = await execute(plan)
	expect(result.status).toBe('confirmed')
	expect(result.canFinishRename).toBe(true)
	for (const [name, definition] of [
		['sql', sql],
		['correlation', correlation],
	] as const)
		expect((await rule(sub('billing', destination.name), name)).definition).toEqual(definition)
	expect((await rule(sub('billing', destination.name), '$Default')).definition.filterType).toBe(
		'true',
	)
	expect(
		(await host.request('sb.rules', { ...request(), target: sub('empty', destination.name) }))
			.items,
	).toEqual([])
	expect((await config(source)).settings.status).toBe('Active')
})
it('supports shallow topic duplication and cross-topic subscription duplication but keeps renames complete and in scope', async () => {
	await start()
	await expect(preview(spec(queue('orders'), queue('../bad')))).rejects.toMatchObject({
		code: '-32602',
	})
	const shallow = spec(topic('order-events'), topic('copy-shallow'), 'duplicate', false)
	expect((await execute(await preview(shallow))).status).toBe('confirmed')
	expect(
		(
			await host.request('sb.list', {
				...request(),
				kind: 'subscription',
				topicName: 'copy-shallow',
			})
		).items,
	).toEqual([])
	const cross = spec(sub('billing', 'order-events'), sub('new-billing', 'copy-shallow'))
	expect((await execute(await preview(cross))).status).toBe('confirmed')
	for (const invalid of [
		{ ...shallow, mode: 'rename' as const },
		{ ...cross, mode: 'rename' as const },
		spec(queue('orders'), queue('ORDERS')),
	]) {
		expect(entityCopySpecSchema.safeParse(invalid).success).toBe(false)
		await expect(preview(invalid)).rejects.toMatchObject({ code: '-32602' })
	}
})
it('rejects existing destinations, wrong confirmation, missing parents and unsupported source settings without writing', async () => {
	await start()
	for (const destination of [queue('ORDERS'), queue('order-events')])
		await expect(preview(spec(queue('empty'), destination))).rejects.toMatchObject({
			code: '-32030',
		})
	await expect(
		preview(spec(sub('billing', 'order-events'), sub('billing', 'missing'))),
	).rejects.toMatchObject({ code: '-32030' })
	await create(queue('copy-unsupported'), { userMetadata: 'unsupported-copy' })
	await expect(preview(spec(queue('copy-unsupported'), queue('copy-new')))).rejects.toMatchObject(
		{
			code: '-32044',
		},
	)
	const plan = await preview(spec(queue('empty'), queue('copy-new')))
	await expect(
		host.request('sb.entity.copy.execute', { ...execution(plan), confirmation: 'copy-new' }),
	).rejects.toMatchObject({ code: '-32602' })
	await expect(config(queue('copy-new'))).rejects.toMatchObject({ code: '-32004' })
	expect((await execute(plan)).status).toBe('confirmed')
})
it('rechecks source settings, rules and subscription inventory before the first write', async () => {
	await start()
	for (const change of ['settings', 'rules', 'inventory']) {
		const destination = topic('copy-stale-' + change),
			plan = await preview(spec(topic('order-events'), destination))
		if (change === 'settings') await update(topic('order-events'), { userMetadata: 'changed' })
		if (change === 'rules') await addRule(sub('billing', 'order-events'), 'added')
		if (change === 'inventory') await create(sub('extra', 'order-events'))
		const result = await execute(plan)
		expect(result.status).toBe('rejected')
		expect(result.steps).toEqual([])
		await expect(config(destination)).rejects.toMatchObject({ code: '-32004' })
	}
})
it('retains a disabled partial destination and detailed receipt after a known rule failure, without rollback or secret leakage', async () => {
	await start()
	await addRule(sub('billing', 'order-events'), 'failing-rule')
	const result = await execute(
		await preview(spec(topic('order-events'), topic('copy-fail-events'))),
	)
	expect(result.status).toBe('partial')
	expect(result.canFinishRename).toBe(false)
	expect(result.steps.some((s) => s.status === 'rejected' && s.ruleName === 'failing-rule')).toBe(
		true,
	)
	expect((await config(topic('copy-fail-events'))).settings.status).toBe('Disabled')
	expect((await config(topic('order-events'))).settings.status).toBe('Active')
	expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('deduplicates uncertain writes and recovers receipts after post-dispatch cancellation', async () => {
	await start()
	for (const name of ['unknown-copy', 'slow-copy']) {
		const plan = await preview(spec(queue('empty'), queue(name))),
			input = execution(plan)
		if (name === 'slow-copy') {
			const abort = new AbortController(),
				pending = host.request('sb.entity.copy.execute', input, { signal: abort.signal })
			setTimeout(() => abort.abort(), 150)
			await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
		}
		const result = await host.request('sb.entity.copy.execute', input)
		expect(result.status).toBe('unknown')
		expect(result.steps).toHaveLength(1)
		expect(
			await host.request('sb.entity.copy.result', { ...request(), operationId: input.id }),
		).toEqual(result)
		expect((await config(queue(name))).settings.status).toBe('Disabled')
		await expect(
			host.request('sb.entity.copy.execute', { ...input, confirmation: 'changed' }),
		).rejects.toMatchObject({ code: '-32602' })
		expect(JSON.stringify(result)).not.toContain('SECRET')
	}
})
it('keeps rename source until a separate current, empty and disabled review is confirmed', async () => {
	await start()
	const source = queue('copy-source'),
		destination = queue('copy-renamed'),
		value = spec(source, destination, 'rename')
	await create(source)
	const result = await execute(await preview(value))
	expect(result.status).toBe('confirmed')
	expect((await config(source)).settings.status).toBe('Active')
	expect((await review(result.operationId)).blockers.join()).toContain('Disable the source')
	await update(source, { status: 'Disabled' })
	const checked = await review(result.operationId)
	expect(checked.blockers).toEqual([])
	const input = {
		...request(),
		reviewId: checked.reviewId,
		confirmation: entityCopyConfirmation(namespace, value, true),
	}
	await expect(
		host.request('sb.entity.rename.finish', { ...input, confirmation: 'delete' }),
	).rejects.toMatchObject({ code: '-32602' })
	const removed = await host.request('sb.entity.rename.finish', input)
	expect(removed.status).toBe('confirmed')
	expect(await host.request('sb.entity.rename.finish', input)).toEqual(removed)
	await expect(config(source)).rejects.toMatchObject({ code: '-32004' })
	expect((await config(destination)).settings.status).toBe('Active')
	expect(
		(
			await host.request('sb.entity.copy.result', {
				...request(),
				operationId: result.operationId,
			})
		)?.canFinishRename,
	).toBe(false)
})
it('blocks removal for active, dead-letter, unavailable or child counts and owned receivers', async () => {
	await start()
	for (const [source, patch] of [
		[queue('orders'), {}],
		[queue('copy-missing'), { userMetadata: 'missing-counts' }],
		[topic('order-events'), {}],
	] as const) {
		if (source.name === 'copy-missing') await create(source, patch)
		const result = await execute(
			await preview(
				spec(source, { ...source, name: 'copy-' + source.name + '-new' }, 'rename'),
			),
		)
		await update(source, { status: 'Disabled' })
		expect((await review(result.operationId)).blockers.join()).toContain(
			'messages or unavailable counts',
		)
	}
	const source = queue('copy-held')
	await create(source)
	const result = await execute(await preview(spec(source, queue('copy-held-new'), 'rename')))
	await update(source, { status: 'Disabled' })
	await host.request('sb.receive', {
		...request(),
		target: source,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	expect((await review(result.operationId)).blockers.join()).toContain('Close the owned source')
})
it('rechecks a review before deletion and detects source replacement and destination changes', async () => {
	await start()
	const source = queue('copy-review'),
		destination = queue('copy-review-new'),
		value = spec(source, destination, 'rename')
	await create(source)
	const result = await execute(await preview(value))
	await update(source, { status: 'Disabled' })
	const checked = await review(result.operationId)
	await update(source, { userMetadata: 'changed after review' })
	expect(
		(
			await host.request('sb.entity.rename.finish', {
				...request(),
				reviewId: checked.reviewId,
				confirmation: entityCopyConfirmation(namespace, value, true),
			})
		).status,
	).toBe('rejected')
	await update(source, { userMetadata: '' })
	await update(destination, { maxDeliveryCount: 17 })
	expect((await review(result.operationId)).blockers.join()).toContain(
		'Destination configuration changed',
	)
	await update(destination, { maxDeliveryCount: 10 })
	expect((await remove(source)).status).toBe('confirmed')
	await create(source, { status: 'Disabled' })
	expect((await review(result.operationId)).blockers.join()).toContain('Source settings')
})
it('records unknown source deletion once and never offers another deletion for that staged rename', async () => {
	await start()
	const source = queue('copy-unknown-delete'),
		value = spec(source, queue('copy-retained'), 'rename')
	await create(source)
	const result = await execute(await preview(value))
	await update(source, { status: 'Disabled' })
	const checked = await review(result.operationId),
		input = {
			...request(),
			reviewId: checked.reviewId,
			confirmation: entityCopyConfirmation(namespace, value, true),
		}
	const removed = await host.request('sb.entity.rename.finish', input)
	expect(removed.status).toBe('unknown')
	expect(await host.request('sb.entity.rename.finish', input)).toEqual(removed)
	expect(
		await host.request('sb.entity.rename.result', { ...request(), operationId: input.id }),
	).toEqual(removed)
	await expect(review(result.operationId)).rejects.toMatchObject({ code: '-32030' })
	expect((await config(value.destination)).settings.status).toBe('Active')
})
it('rejects oversized entity inventories and invalidates copy plans on disconnect', async () => {
	await start()
	const source = topic('copy-large')
	await create(source)
	for (let i = 0; i < 50; i++) await create(sub('s' + i, source.name))
	await expect(preview(spec(source, topic('copy-large-new')))).rejects.toMatchObject({
		code: '-32011',
	})
	const plan = await preview(spec(queue('empty'), queue('copy-reset')))
	await host.request('sb.reset', {})
	await expect(execute(plan)).rejects.toMatchObject({ code: '-32010' })
})

for (const kind of ['topic', 'subscription'] as const) {
	it(`finishes an empty ${kind} rename after cutover and retains copied rules`, async () => {
		await start()
		const parent = topic('copy-tree')
		await create(parent)
		const child = sub('billing', parent.name)
		await create(child)
		await addRule(child, 'route', {
			...defaultRule(),
			actionExpression: "SET user.route = 'new';",
		})
		const source = kind === 'topic' ? parent : child
		const destination =
			kind === 'topic' ? topic('copy-tree-new') : sub('billing-new', parent.name)
		const value = spec(source, destination, 'rename')
		const result = await execute(await preview(value))
		expect(result.status).toBe('confirmed')
		await update(source, { status: 'Disabled' })
		const checked = await review(result.operationId)
		expect(checked.blockers).toEqual([])
		expect(
			(
				await host.request('sb.entity.rename.finish', {
					...request(),
					reviewId: checked.reviewId,
					confirmation: entityCopyConfirmation(namespace, value, true),
				})
			).status,
		).toBe('confirmed')
		await expect(config(source)).rejects.toMatchObject({ code: '-32004' })
		expect(
			(
				await rule(
					kind === 'topic'
						? sub('billing', destination.name)
						: sub(destination.name, parent.name),
					'route',
				)
			).definition.actionExpression,
		).toBe("SET user.route = 'new';")
	})
}
