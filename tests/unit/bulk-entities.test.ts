import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { defaultEntitySettings } from '../../src/shared/entity-management'
import {
	bulkEntityPreviewRequestSchema,
	bulkEntityExecuteRequestSchema,
	type BulkEntityAction,
	type BulkEntityPlan,
	type BulkEntityProgress,
} from '../../src/shared/bulk-entities'
import type { EntityTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
const queue = (name: string): EntityTarget => ({ kind: 'queue', name })
const topic = (name = 'order-events'): EntityTarget => ({ kind: 'topic', name })
const sub = (name: string, topicName = 'order-events'): EntityTarget => ({
	kind: 'subscription',
	name,
	topicName,
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
const create = (target: EntityTarget) =>
	host.request('sb.entity.create', {
		...request(),
		target,
		settings: defaultEntitySettings(target.kind),
	})
const config = (target: EntityTarget) => host.request('sb.entity-config', { ...request(), target })
const previewInput = (
	targets: EntityTarget[],
	action: BulkEntityAction = { kind: 'delete' },
	maxSeconds = 10,
) => ({ ...request(), targets, action, maxSeconds })
const preview = (targets: EntityTarget[], action?: BulkEntityAction, seconds?: number) =>
	host.request('sb.entity.bulk.preview', previewInput(targets, action, seconds))
const executeInput = (plan: BulkEntityPlan) => ({
	...request(),
	planId: plan.planId,
	confirmation: plan.confirmation,
})
const execute = (input: ReturnType<typeof executeInput>, signal?: AbortSignal) =>
	host.request('sb.entity.bulk.execute', input, {
		signal,
		waitForCancellation: true,
		timeout: 15000,
	})
afterEach(async () => {
	await host?.stop()
})
it('rejects invalid/duplicate selections and incompatible partial statuses before any mutations', async () => {
	await start()
	const good = previewInput([queue('orders')])
	for (const input of [
		{ ...good, targets: [] },
		{ ...good, targets: Array.from({ length: 101 }, (_, i) => queue(`q${i}`)) },
		{ ...good, targets: [queue('orders'), queue('ORDERS')] },
		{ ...good, maxSeconds: 0 },
		{ ...good, maxSeconds: 601 },
		{ ...good, action: { kind: 'status', status: 'Creating' } },
		{ ...good, targets: [topic()], action: { kind: 'status', status: 'ReceiveDisabled' } },
		{ ...good, targets: [sub('billing')], action: { kind: 'status', status: 'SendDisabled' } },
	]) {
		expect(bulkEntityPreviewRequestSchema.safeParse(input).success).toBe(false)
		await expect(host.request('sb.entity.bulk.preview', input as never)).rejects.toThrow()
	}
	await expect(preview([queue('orders'), queue('missing')])).rejects.toThrow('Could not review')
	expect((await config(queue('orders'))).settings.status).toBe('Active')
})
it('previews the full topic cascade, deduplicates selected children and deletes only reviewed roots', async () => {
	await start()
	const plan = await preview([sub('billing'), topic(), queue('empty')])
	expect(plan.affectedCount).toBe(4)
	expect(plan.items.map((item) => item.target)).toEqual([topic(), queue('empty')])
	expect(plan.items[0].subscriptions.map((item) => item.name)).toEqual(['audit', 'billing'])
	const result = await execute(executeInput(plan))
	expect(result).toMatchObject({ status: 'completed', confirmed: 2, uncertain: 0 })
	for (const target of [topic(), sub('billing'), sub('audit'), queue('empty')])
		await expect(config(target)).rejects.toThrow()
	expect((await config(queue('orders'))).settings.status).toBe('Active')
})
it('binds namespace/action/count confirmation to a one-use plan and returns duplicate receipts without retry', async () => {
	await start()
	const plan = await preview([queue('orders')], { kind: 'status', status: 'Disabled' }),
		input = executeInput(plan)
	expect(
		bulkEntityExecuteRequestSchema.safeParse({ ...input, targets: [queue('empty')] }).success,
	).toBe(false)
	await expect(execute({ ...input, confirmation: 'DELETE' })).rejects.toThrow('Confirm')
	const result = await execute(input)
	expect(await execute(input)).toEqual(result)
	await expect(execute({ ...input, confirmation: 'another' })).rejects.toThrow(
		'different request',
	)
	await expect(execute({ ...input, id: randomUUID() })).rejects.toThrow('already used')
	expect(
		await host.request('sb.entity.bulk.result', { ...request(), operationId: input.id }),
	).toEqual(result)
	await host.request('sb.disconnect', { connectionId })
	await expect(
		host.request('sb.entity.bulk.result', { ...request(), operationId: input.id }),
	).rejects.toThrow('Connection expired')
})
it('changes only status across mixed kinds, retains settings/rules and reports already-set targets', async () => {
	await start()
	const targets = [queue('orders'), topic(), sub('billing')]
	const original = await Promise.all(targets.map(config))
	const rules = await host.request('sb.rules', {
		...request(),
		target: sub('billing') as never,
		continuationToken: null,
	})
	const events: BulkEntityProgress[] = []
	host.on('event', (event) => {
		if (event.type === 'bulk-entity-progress') events.push(event)
	})
	const result = await execute(
		executeInput(await preview(targets, { kind: 'status', status: 'Disabled' })),
	)
	expect(result).toMatchObject({ confirmed: 3, status: 'completed' })
	for (const [i, target] of targets.entries())
		expect((await config(target)).settings).toEqual({
			...original[i].settings,
			status: 'Disabled',
		})
	expect(
		await host.request('sb.rules', {
			...request(),
			target: sub('billing') as never,
			continuationToken: null,
		}),
	).toEqual(rules)
	expect(events.at(-1)).toMatchObject({ confirmed: 3, phase: 'finished', activeIndex: null })
	const noop = await execute(
		executeInput(await preview(targets, { kind: 'status', status: 'Disabled' })),
	)
	expect(noop.confirmed).toBe(0)
	expect(noop.items.every((row) => row.status === 'unchanged')).toBe(true)
})
it('fails the whole preflight when a later entity changed; earlier targets are not changed', async () => {
	await start()
	const plan = await preview([queue('orders'), queue('empty')])
	const current = await config(queue('empty'))
	await host.request('sb.entity.update', {
		...request(),
		target: queue('empty'),
		settings: { ...current.settings, userMetadata: 'external edit' },
		expectedRevision: current.revision,
	})
	const result = await execute(executeInput(plan))
	expect(result).toMatchObject({ confirmed: 0, status: 'failed' })
	expect(result.items.map((row) => row.status)).toEqual(['not-started', 'rejected'])
	expect(result.items[1].summary).toContain('changed since review')
	await config(queue('orders'))
})
it('rejects a changed topic cascade before deleting any reviewed entity', async () => {
	await start()
	const plan = await preview([queue('orders'), topic()])
	await create(sub('new-subscription'))
	const result = await execute(executeInput(plan))
	expect(result).toMatchObject({ confirmed: 0, status: 'failed' })
	expect(result.items[1].summary).toContain('subscription list changed')
	await config(topic())
	await config(queue('orders'))
	await config(sub('new-subscription'))
})
it('stops on known rejection with earlier successes and later targets retained', async () => {
	await start()
	await create(queue('bulk-denied'))
	const result = await execute(
		executeInput(await preview([queue('empty'), queue('bulk-denied'), queue('orders')])),
	)
	expect(result).toMatchObject({ status: 'failed', confirmed: 1, uncertain: 0 })
	expect(result.items.map((row) => row.status)).toEqual(['confirmed', 'rejected', 'not-started'])
	expect(JSON.stringify(result)).not.toContain('SECRET')
	await config(queue('orders'))
})
it('retains unknown acknowledgements and never advances or automatically repeats them', async () => {
	await start()
	await create(queue('bulk-unknown'))
	const input = executeInput(
		await preview([queue('empty'), queue('bulk-unknown'), queue('orders')]),
	)
	const result = await execute(input)
	expect(result).toMatchObject({ status: 'unknown', confirmed: 1, uncertain: 1 })
	expect(result.items.map((row) => row.status)).toEqual(['confirmed', 'unknown', 'not-started'])
	expect(await execute(input)).toEqual(result)
	await expect(config(queue('bulk-unknown'))).rejects.toThrow()
	await config(queue('orders'))
	expect(JSON.stringify(result)).not.toContain('SECRET')
})
it('cancels before dispatch and leaves later targets untouched, retaining partial progress', async () => {
	await start()
	await create(queue('bulk-wait-before'))
	const input = executeInput(
		await preview([queue('empty'), queue('bulk-wait-before'), queue('orders')]),
	)
	const controller = new AbortController()
	host.on('event', (event) => {
		if (
			event.type === 'bulk-entity-progress' &&
			event.phase === 'applying' &&
			event.activeIndex === 1
		)
			setTimeout(() => controller.abort(), 50)
	})
	const result = await execute(input, controller.signal)
	expect(result).toMatchObject({ status: 'cancelled', confirmed: 1, uncertain: 0 })
	expect(result.items.map((row) => row.status)).toEqual(['confirmed', 'cancelled', 'not-started'])
	await config(queue('bulk-wait-before'))
	await config(queue('orders'))
	expect(
		await host.request('sb.entity.bulk.result', { ...request(), operationId: input.id }),
	).toEqual(result)
})
it('treats cancellation after dispatch as unknown but preserves acknowledgements that win the race', async () => {
	await start()
	for (const name of ['bulk-wait-dispatched', 'bulk-commit-late']) {
		await create(queue(name))
		const input = executeInput(await preview([queue(name), queue('orders')]))
		const controller = new AbortController()
		const listener = (event: BulkEntityProgress) => {
			if (
				event.type === 'bulk-entity-progress' &&
				event.operationId === input.id &&
				event.phase === 'applying' &&
				event.activeIndex === 0
			)
				setTimeout(() => controller.abort(), 50)
		}
		host.on('event', listener)
		const result = await execute(input, controller.signal)
		host.off('event', listener)
		expect(result.status).toBe(name === 'bulk-wait-dispatched' ? 'unknown' : 'cancelled')
		expect(result.confirmed).toBe(name === 'bulk-commit-late' ? 1 : 0)
		expect(result.items[1].status).toBe('not-started')
	}
})
it('applies a whole-job time limit without deleting later entities', async () => {
	await start()
	await create(queue('bulk-wait-before'))
	const result = await execute(
		executeInput(
			await preview(
				[queue('empty'), queue('bulk-wait-before'), queue('orders')],
				{ kind: 'delete' },
				1,
			),
		),
	)
	expect(result).toMatchObject({ status: 'limited', confirmed: 1 })
	expect(result.items[2].status).toBe('not-started')
})
it('recovers an interrupted transport receipt without re-executing the action', async () => {
	await start()
	await create(queue('bulk-commit-late'))
	const input = executeInput(await preview([queue('bulk-commit-late'), queue('orders')]))
	await expect(
		host.request('sb.entity.bulk.execute', input, { timeout: 80, waitForCancellation: true }),
	).rejects.toMatchObject({ code: 'TIMEOUT' })
	const result = await host.request('sb.entity.bulk.result', {
		...request(),
		operationId: input.id,
	})
	expect(result).toMatchObject({ status: 'cancelled', confirmed: 1, uncertain: 0 })
	expect(result!.items[1].status).toBe('not-started')
	expect(await execute(input)).toEqual(result)
})
it('rechecks receiver/listener ownership after review', async () => {
	await start()
	const plan = await preview([queue('orders')])
	await host.request('sb.receive', {
		...request(),
		target: queue('orders') as never,
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(execute(executeInput(plan))).rejects.toThrow('Close the message/session')
	await host.request('sb.close-receiver', request())
	const listener = await host.request('sb.listener.start', {
		...request(),
		target: queue('empty') as never,
		sessionId: '',
		mode: 'manual',
		maxMessages: 10,
		maxSeconds: 60,
		maxLockSeconds: 60,
	})
	await expect(preview([queue('orders')])).rejects.toThrow('Stop the listener')
	await expect(execute(executeInput(plan))).rejects.toThrow('Stop the listener')
	await host.request('sb.listener.stop', { ...request(), listenerId: listener.listenerId })
})
