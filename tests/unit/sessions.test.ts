import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { emptyDraft } from '../../src/main/features/service-bus/files/message-archive'
import { acceptSessionRequestSchema, setSessionStateRequestSchema } from '../../src/shared/sessions'
import type { PeekTarget } from '../../src/shared/service-bus'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend, connectionId: string
const target: PeekTarget = { kind: 'queue', name: 'sessions' }
const subscription: PeekTarget = { kind: 'subscription', name: 'audit', topicName: 'order-events' }
const request = () => ({ id: randomUUID(), connectionId })
const list = (destination: PeekTarget = target, continuationToken: string | null = null) =>
	host.request('sb.sessions', { ...request(), target: destination, continuationToken })
const accept = (sessionId = 'session-001', destination: PeekTarget = target) =>
	host.request('sb.session.accept', { ...request(), target: destination, sessionId })
const read = (leaseId: string) => host.request('sb.session.state', { ...request(), leaseId })
const held = () => host.request('sb.deliveries', request())
const release = (leaseId: string) => host.request('sb.session.release', { ...request(), leaseId })
const save = (
	leaseId: string,
	expectedRevision: string,
	bodyBase64: string | null,
	confirmation = '',
) =>
	host.request('sb.session.state.set', {
		...request(),
		leaseId,
		expectedRevision,
		bodyBase64,
		confirmation,
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
afterEach(async () => {
	await host?.stop()
})
it('uses SDK listing without accepting locks, routes sessions and round-trips binary/null state', () => {
	expect(execFileSync('dotnet', [dll, '--session-checks'], { encoding: 'utf8' })).toContain(
		'Session adapter checks passed',
	)
})
it('pages active and state-only sessions without acquiring receivers and fences listing cursors', async () => {
	await start()
	const first = await list()
	expect(first.items).toHaveLength(100)
	expect(first.continuationToken).not.toBeNull()
	const second = await list(target, first.continuationToken)
	expect(second.items).toHaveLength(5)
	expect(second.items).toContain('state-only')
	expect(second.continuationToken).toBeNull()
	expect((await held()).session).toBeNull()
	expect((await held()).items).toHaveLength(0)
	await expect(list(target, first.continuationToken)).rejects.toThrow('cursor expired')
	const fresh = await list()
	await expect(list(subscription, fresh.continuationToken)).rejects.toThrow('cursor expired')
	await host.request('sb.sessions.close', {
		...request(),
		continuationToken: fresh.continuationToken!,
	})
	await expect(list(target, fresh.continuationToken)).rejects.toThrow('cursor expired')
	expect((await list(subscription)).items).toHaveLength(100)
})
it('owns a state-only session, preserves exact state bytes, checks revisions and explicitly clears state', async () => {
	await start()
	const initial = await accept('state-only')
	const lease = initial.session!
	expect(initial.items).toHaveLength(0)
	expect((await accept('state-only')).session!.leaseId).toBe(lease.leaseId)
	let state = await read(lease.leaseId)
	expect(Buffer.from(state.bodyBase64!, 'base64').toString()).toBe('retained with no messages')
	const bytes = Buffer.from('{"checkpoint":9007199254740993,"city":"Málaga 🚀"}').toString(
		'base64',
	)
	expect((await save(lease.leaseId, state.revision!, bytes)).status).toBe('confirmed')
	expect((await save(lease.leaseId, state.revision!, 'AP9B')).summary).toContain('state changed')
	state = await read(lease.leaseId)
	expect(state.bodyBase64).toBe(bytes)
	expect((await save(lease.leaseId, state.revision!, null, 'wrong')).status).toBe('rejected')
	expect((await save(lease.leaseId, state.revision!, '')).status).toBe('confirmed')
	state = await read(lease.leaseId)
	expect(state).toMatchObject({ isSet: true, bytes: 0, bodyBase64: '' })
	expect((await save(lease.leaseId, state.revision!, null, 'state-only')).status).toBe(
		'confirmed',
	)
	expect(await read(lease.leaseId)).toMatchObject({ isSet: false, bytes: 0, bodyBase64: null })
	expect((await held()).items).toHaveLength(0)
	await release(lease.leaseId)
	const newLease = (await accept('state-only')).session!
	expect(newLease.leaseId).not.toBe(lease.leaseId)
	expect((await read(newLease.leaseId)).isSet).toBe(false)
	await expect(read(lease.leaseId)).rejects.toThrow('lease expired')
	await expect(release(lease.leaseId)).rejects.toThrow('lease expired')
})
it('receives only the selected session and keeps its receiver across settled batches and state operations', async () => {
	await start()
	const lease = (await accept()).session!
	await host.request('sb.send', {
		...request(),
		target,
		draft: {
			...emptyDraft('eA=='),
			messageId: 'other-session-message',
			sessionId: 'session-002',
		},
	})
	const receive = (maxMessages = 1) =>
		host.request('sb.receive', {
			...request(),
			target,
			sessionId: lease.sessionId,
			sessionLeaseId: lease.leaseId,
			subQueue: 'active',
			maxMessages,
			waitSeconds: 1,
		})
	const batch = await receive()
	expect(batch.session!.leaseId).toBe(lease.leaseId)
	expect(batch.items).toHaveLength(1)
	expect(batch.items[0].summary.sessionId).toBe(lease.sessionId)
	await expect(receive()).rejects.toThrow('Settle the current batch')
	await expect(accept('state-only')).rejects.toThrow('Close the current receiver')
	const before = Date.parse(batch.items[0].lockedUntil)
	expect(
		(await host.request('sb.session.renew', { ...request(), leaseId: lease.leaseId })).status,
	).toBe('confirmed')
	expect(Date.parse((await held()).items[0].lockedUntil)).toBeGreaterThan(before)
	expect((await read(lease.leaseId)).isSet).toBe(true)
	await host.request('sb.settle', {
		...request(),
		deliveryId: batch.items[0].deliveryId,
		action: 'complete',
		reason: '',
		description: '',
	})
	const next = await receive(2)
	expect(next.items).toHaveLength(1)
	expect(next.session!.leaseId).toBe(lease.leaseId)
	expect(next.items[0].summary.messageId).toBe('received-002')
	await release(lease.leaseId)
	expect((await held()).session).toBeNull()
	const again = (await accept()).session!
	expect(again.leaseId).not.toBe(lease.leaseId)
	await expect(
		host.request('sb.receive', {
			...request(),
			target,
			sessionId: 'state-only',
			sessionLeaseId: again.leaseId,
			subQueue: 'active',
			maxMessages: 1,
			waitSeconds: 1,
		}),
	).rejects.toThrow('Release the owned session')
})
it('supports subscription state and binary values and rejects non-session entities, topics and invalid IDs', async () => {
	await start()
	const lease = (await accept('binary-state', subscription)).session!
	expect(lease.target).toEqual(subscription)
	expect((await read(lease.leaseId)).bodyBase64).toBe('AP9B')
	await release(lease.leaseId)
	await expect(accept('x', { kind: 'queue', name: 'orders' })).rejects.toThrow('session-enabled')
	await expect(
		host.request('sb.sessions', {
			...request(),
			target: { kind: 'topic', name: 'events' } as never,
			continuationToken: null,
		}),
	).rejects.toThrow()
	await expect(accept(' ')).rejects.toThrow('session ID')
	expect(
		acceptSessionRequestSchema.safeParse({
			...request(),
			target,
			sessionId: 'x',
			path: '/tmp/no',
		}).success,
	).toBe(false)
	expect(
		setSessionStateRequestSchema.safeParse({
			...request(),
			leaseId: randomUUID(),
			expectedRevision: 'bad',
			bodyBase64: '',
			confirmation: '',
		}).success,
	).toBe(false)
})
it('bounds state reads without truncating and rejects malformed or oversized writes before dispatch', async () => {
	await start()
	let lease = (await accept('large-state')).session!
	expect(await read(lease.leaseId)).toMatchObject({
		isSet: true,
		bytes: 300000,
		bodyBase64: null,
		editable: false,
		revision: null,
	})
	expect((await save(lease.leaseId, 'A'.repeat(64), null, 'large-state')).status).toBe('rejected')
	await release(lease.leaseId)
	lease = (await accept('binary-state')).session!
	const state = await read(lease.leaseId)
	for (const bad of ['AB==', '%%%=', Buffer.alloc(262145).toString('base64')])
		expect((await save(lease.leaseId, state.revision!, bad)).status).toBe('rejected')
	expect((await read(lease.leaseId)).bodyBase64).toBe('AP9B')
})
it('blocks uncertain state writes until explicit broker reads and does not repeat receipts', async () => {
	await start()
	const lease = (await accept('unknown-state')).session!
	const state = await read(lease.leaseId)
	const input = {
		...request(),
		leaseId: lease.leaseId,
		expectedRevision: state.revision!,
		bodyBase64: 'AP9B',
		confirmation: '',
	}
	const outcome = await host.request('sb.session.state.set', input)
	expect(outcome.status).toBe('unknown')
	expect(outcome.summary).not.toContain('SECRET')
	expect(await host.request('sb.session.state.set', input)).toEqual(outcome)
	expect((await held()).session!.stateUncertain).toBe(true)
	expect((await save(lease.leaseId, state.revision!, 'eA==')).status).toBe('rejected')
	expect((await held()).session!.stateUncertain).toBe(true)
	expect((await read(lease.leaseId)).bodyBase64).toBe('AP9B')
	expect((await held()).session!.stateUncertain).toBe(false)
	expect((await save(lease.leaseId, state.revision!, 'eA==')).summary).toContain('state changed')
})
it('reports locked sessions, lost locks and uncertain renewals without false success', async () => {
	await start()
	await expect(accept('locked-session')).rejects.toThrow('locked by another')
	expect((await held()).session).toBeNull()
	let lease = (await accept('lost-session')).session!
	await expect(read(lease.leaseId)).rejects.toThrow('lock was lost')
	expect((await held()).session!.status).toBe('lock-lost')
	expect(
		(await host.request('sb.session.renew', { ...request(), leaseId: lease.leaseId })).status,
	).toBe('rejected')
	await release(lease.leaseId)
	lease = (await accept('unknown-renew')).session!
	expect(
		(await host.request('sb.session.renew', { ...request(), leaseId: lease.leaseId })).status,
	).toBe('unknown')
	expect((await held()).session!.status).toBe('unknown')
	await expect(read(lease.leaseId)).rejects.toThrow('lock is lost or uncertain')
	await release(lease.leaseId)
})
it('tracks cancellation after state dispatch and acknowledgement races without automatic repetition', async () => {
	await start()
	for (const id of ['slow-state', 'commit-late-state']) {
		const lease = (await accept(id)).session!,
			state = await read(lease.leaseId)
		const controller = new AbortController(),
			input = {
				...request(),
				leaseId: lease.leaseId,
				expectedRevision: state.revision!,
				bodyBase64: 'AP9B',
				confirmation: '',
			}
		const pending = host.request('sb.session.state.set', input, { signal: controller.signal })
		setTimeout(() => controller.abort(), 50)
		await expect(pending).rejects.toThrow()
		const outcome = await host.request('sb.outcome', { ...request(), operationId: input.id })
		expect(outcome?.status).toBe(id === 'slow-state' ? 'unknown' : 'confirmed')
		expect((await read(lease.leaseId)).bodyBase64).toBe(id === 'slow-state' ? null : 'AP9B')
		await release(lease.leaseId)
	}
})
it('cancels session scans, sanitizes denials and invalidates lease/cursor handles on reconnect', async () => {
	await start()
	await expect(list({ kind: 'queue', name: 'session-test-denied' })).rejects.toThrow('denied')
	const controller = new AbortController()
	const pending = host.request(
		'sb.sessions',
		{
			...request(),
			target: { kind: 'queue', name: 'session-test-slow' },
			continuationToken: null,
		},
		{ signal: controller.signal },
	)
	setTimeout(() => controller.abort(), 50)
	await expect(pending).rejects.toThrow()
	const page = await list(),
		lease = (await accept()).session!,
		old = connectionId
	await host.request('sb.reset', {})
	await expect(read(lease.leaseId)).rejects.toThrow('Connection expired')
	await expect(
		host.request('sb.sessions', {
			id: randomUUID(),
			connectionId: old,
			target,
			continuationToken: page.continuationToken,
		}),
	).rejects.toThrow('Connection expired')
})

it('propagates a lost session lock to all held message handles', async () => {
	await start()
	const lease = (await accept('lose-after-receive')).session!
	await host.request('sb.send', {
		...request(),
		target,
		draft: { ...emptyDraft('eA=='), sessionId: 'lose-after-receive' },
	})
	await host.request('sb.receive', {
		...request(),
		target,
		sessionId: lease.sessionId,
		sessionLeaseId: lease.leaseId,
		subQueue: 'active',
		maxMessages: 1,
		waitSeconds: 1,
	})
	await expect(read(lease.leaseId)).rejects.toThrow('session lock was lost')
	const state = await held()
	expect(state.session!.status).toBe('lock-lost')
	expect(state.items).toHaveLength(1)
	expect(state.items[0].state).toBe('lock-lost')
})
