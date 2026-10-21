import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	defaultEntitySettings,
	entityPath,
	type EntityConfiguration,
	type EntitySettings,
} from '../../src/shared/entity-management'
import type { EntityTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const request = () => ({ id: randomUUID(), connectionId })
const queue = (name = 'orders'): EntityTarget => ({ kind: 'queue', name })
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
				name: 'Fixture',
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
const config = (target = queue()) => host.request('sb.entity-config', { ...request(), target })
const create = (target: EntityTarget, settings = defaultEntitySettings(target.kind)) =>
	host.request('sb.entity.create', { ...request(), target, settings })
const update = (current: EntityConfiguration, patch: Partial<EntitySettings>) =>
	host.request('sb.entity.update', {
		...request(),
		target: current.target,
		expectedRevision: current.revision,
		settings: { ...current.settings, ...patch },
	})
const remove = (current: EntityConfiguration, confirmation = entityPath(current.target)) =>
	host.request('sb.entity.delete', {
		...request(),
		target: current.target,
		expectedRevision: current.revision,
		confirmation,
	})

it('executes actual Azure management SDK routing and preserves unknown properties, keys and filters on update', () => {
	expect(execFileSync('dotnet', [dll, '--entity-checks'], { encoding: 'utf8' })).toContain(
		'Entity adapter checks passed',
	)
})
it('creates, reads, edits and deletes all three kinds and refreshes browsing status/session flags', async () => {
	await start()
	const targets: EntityTarget[] = [
		queue('new-queue'),
		{ kind: 'topic', name: 'new-topic' },
		{ kind: 'subscription', name: 'new-sub', topicName: 'new-topic' },
	]
	for (const target of targets) {
		const settings = {
			...defaultEntitySettings(target.kind),
			userMetadata: 'Málaga 🚀',
			requiresSession: target.kind === 'topic' ? null : true,
		}
		expect((await create(target, settings)).status).toBe('confirmed')
		const current = await config(target)
		expect(current.settings).toEqual(settings)
		expect((await update(current, { status: 'Disabled', userMetadata: 'Edited' })).status).toBe(
			'confirmed',
		)
		const page = await host.request('sb.list', {
			...request(),
			kind: target.kind,
			topicName: target.kind === 'subscription' ? target.topicName : undefined,
		})
		expect(page.items).toContainEqual({
			target,
			status: 'Disabled',
			requiresSession: settings.requiresSession,
		})
	}
	for (const target of targets.reverse()) {
		expect((await remove(await config(target))).status).toBe('confirmed')
		await expect(config(target)).rejects.toMatchObject({ code: '-32004' })
	}
})
it('rejects duplicate names, wrong delete confirmation, missing parents, invalid bounds and creation-only edits', async () => {
	await start()
	expect((await create(queue())).status).toBe('rejected')
	expect(
		(await create({ kind: 'subscription', name: 'new-sub', topicName: 'missing' })).status,
	).toBe('rejected')
	expect((await remove(await config(), 'wrong')).status).toBe('rejected')
	for (const patch of [
		{ lockDuration: '00:05:01' },
		{ autoDeleteOnIdle: '00:04:59' },
		{ defaultMessageTimeToLive: '-01:00:00' },
		{ duplicateDetectionHistoryTimeWindow: '00:00:19' },
		{ forwardTo: 'orders' },
		{ userMetadata: '🚀'.repeat(257) },
		{ supportOrdering: false },
		{ requiresSession: true },
	]) {
		expect((await update(await config(), patch)).status).toBe('rejected')
	}
	expect((await create(queue('../bad'))).status).toBe('rejected')
	expect((await create(queue('a/../b'))).status).toBe('rejected')
	expect((await create(queue('a//b'))).status).toBe('rejected')
	const denied = await create(queue('denied-entity'))
	expect(denied.status).toBe('rejected')
	expect(denied.summary).toContain('Manage')
	expect(JSON.stringify(denied)).not.toContain('SECRET')
})
it('detects stale edits and deletes before mutation and preserves unrelated fields on a fresh edit', async () => {
	await start()
	const first = await config()
	await update(first, { maxDeliveryCount: 25, forwardTo: 'archive' })
	expect((await update(first, { userMetadata: 'stale' })).summary).toContain('changed since')
	expect((await remove(first)).status).toBe('rejected')
	const second = await config()
	await update(second, { userMetadata: 'fresh' })
	expect((await config()).settings).toMatchObject({
		maxDeliveryCount: 25,
		forwardTo: 'archive',
		userMetadata: 'fresh',
	})
})
it('deletes a topic and its subscriptions only, and blocks mutations while affected receivers remain open', async () => {
	await start()
	const topic: EntityTarget = { kind: 'topic', name: 'order-events' }
	await host.request('sb.receive', {
		...request(),
		target: { kind: 'subscription', name: 'billing', topicName: 'order-events' },
		subQueue: 'active',
		sessionId: '',
		maxMessages: 1,
		waitSeconds: 1,
	})
	expect((await remove(await config(topic))).summary).toContain('Close the receiver')
	const currentTopic = await config(topic)
	expect(
		(await remove({ ...currentTopic, target: { kind: 'topic', name: 'ORDER-EVENTS' } }))
			.summary,
	).toContain('Close the receiver')
	expect((await update(await config(topic), { userMetadata: 'blocked' })).status).toBe('rejected')
	expect((await update(await config(), { userMetadata: 'unrelated' })).status).toBe('confirmed')
	await host.request('sb.close-receiver', request())
	expect((await remove(await config(topic))).status).toBe('confirmed')
	await expect(
		config({ kind: 'subscription', name: 'audit', topicName: 'order-events' }),
	).rejects.toMatchObject({ code: '-32004' })
	expect((await config()).settings.userMetadata).toBe('unrelated')
})
it('records ambiguous management writes and never repeats an operation with the same receipt ID', async () => {
	await start()
	const input = {
		...request(),
		target: queue('unknown-entity-create'),
		settings: defaultEntitySettings('queue'),
	}
	const first = await host.request('sb.entity.create', input)
	expect(first.status).toBe('unknown')
	expect(await host.request('sb.entity.create', input)).toEqual(first)
	expect((await config(input.target)).settings).toEqual(input.settings)
	expect(await host.request('sb.outcome', { ...request(), operationId: input.id })).toEqual(first)
	await expect(
		host.request('sb.entity.create', { ...input, target: queue('different') }),
	).rejects.toMatchObject({ code: '-32602' })
	const unknownUpdate = await update(await config(), { userMetadata: 'unknown-update' })
	expect(unknownUpdate.status).toBe('unknown')
	expect((await config()).settings.userMetadata).toBe('unknown-update')
	expect((await remove(await config(input.target))).status).toBe('unknown')
	await expect(config(input.target)).rejects.toMatchObject({ code: '-32004' })
})
it('recovers truthful receipts when cancellation races acceptance and cancels cleanly before dispatch', async () => {
	await start()
	for (const [name, metadata, expected] of [
		['commit-late-entity', '', 'confirmed'],
		['cancel-preflight', 'slow-preflight', 'cancelled'],
		['slow-entity', '', 'unknown'],
	] as const) {
		const input = {
			...request(),
			target: queue(name),
			settings: { ...defaultEntitySettings('queue'), userMetadata: metadata },
		}
		const abort = new AbortController()
		const pending = host.request('sb.entity.create', input, { signal: abort.signal })
		setTimeout(() => abort.abort(), 50)
		await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
		expect(
			(await host.request('sb.outcome', { ...request(), operationId: input.id }))?.status,
		).toBe(expected)
	}
})
it('invalidates peek snapshots after dispatch and rejects stale connection handles', async () => {
	await start()
	const peek = await host.request('sb.peek', {
		...request(),
		target: { kind: 'queue', name: 'orders' },
		subQueue: 'active',
		fromSequenceNumber: '0',
		maxMessages: 1,
	})
	await update(await config(), { userMetadata: 'updated' })
	await expect(
		host.request('sb.inspect', { ...request(), snapshotId: peek.items[0].snapshotId! }),
	).rejects.toMatchObject({ code: '-32013' })
	await host.request('sb.reset', {})
	await expect(create(queue('stale'))).rejects.toMatchObject({ code: '-32010' })
})
