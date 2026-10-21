import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { RecoveryHarness, emulatorProfile } from './support/recovery-harness'
import { defaultEntitySettings, entityPath } from '../../src/shared/entity-management'
import {
	purgeConfirmation,
	receiveDeleteConfirmation,
} from '../../src/shared/contracts/service-bus/maintenance'
import type { EntityTarget } from '../../src/shared/service-bus'

let harness: RecoveryHarness
const created: EntityTarget[] = []
beforeEach(async () => {
	harness = new RecoveryHarness()
	await harness.start()
})
afterEach(async () => {
	try {
		if (harness?.connectionId)
			await harness.host.request('sb.close-receiver', harness.request())
		for (const target of created.splice(0).reverse()) {
			const current = await harness.observer.request('sb.entity-config', {
				...harness.control(),
				target,
			})
			expect(
				await harness.observer.request('sb.entity.delete', {
					...harness.control(),
					target,
					expectedRevision: current.revision,
					confirmation: entityPath(target),
				}),
			).toMatchObject({ status: 'confirmed' })
		}
	} finally {
		await harness?.close()
	}
})
async function evidence(name: string, value: unknown) {
	await mkdir('artifacts', { recursive: true })
	await writeFile(
		`artifacts/refactor-maintenance-${name}-evidence.json`,
		JSON.stringify(value, null, 2) + '\n',
	)
}

it('purges only older messages, then applies an immutable bulk review with an overall limit', async () => {
	await harness.seed()
	const original = (await harness.peek()).items[0]
	const cutoff = new Date(Date.parse(original.enqueuedTime) + 1).toISOString()
	await delay(20)
	await harness.seed()
	const request = {
		...harness.request(),
		target: harness.queue,
		subQueue: 'active' as const,
		maxMessages: 10,
		maxSeconds: 20,
		beforeEnqueueTime: cutoff,
		confirmation: purgeConfirmation('localhost', harness.queue, 'active', cutoff),
	}
	const result = await harness.host.request('sb.purge', request)
	expect(result).toMatchObject({ completed: 1, uncertain: 0, skipped: 1, cleanupWarning: null })
	expect(await harness.host.request('sb.purge', request)).toEqual(result)
	const kept = (await harness.peek()).items
	expect(kept).toHaveLength(1)
	expect(kept[0].messageId).not.toBe(original.messageId)
	// The retained newer delivery is deliberately left unsettled and can remain locked until expiry.
	// Add an available message so the subsequent bulk limit check does not depend on lock release timing.
	await harness.seed()
	const plan = await harness.host.request('sb.purge.bulk.preview', {
		...harness.request(),
		targets: [{ target: harness.queue, subQueue: 'active' }],
		maxPerTarget: 10,
		maxTotal: 1,
		maxSeconds: 20,
	})
	const execute = { ...harness.request(), planId: plan.planId, confirmation: plan.confirmation }
	const bulk = await harness.host.request('sb.purge.bulk', execute)
	await evidence('purge', { cutoff, result, bulk })
	expect(bulk).toMatchObject({ completed: 1, uncertain: 0, reason: 'total-limit' })
	expect(await harness.host.request('sb.purge.bulk', execute)).toEqual(bulk)
	expect((await harness.peek()).items).toHaveLength(1)
})

it('receives and deletes once, retains inspectable bytes and expires consumed snapshots on the next accepted run', async () => {
	await harness.seed(2)
	const request = {
		...harness.request(),
		target: harness.queue,
		subQueue: 'active' as const,
		sessionId: '',
		maxMessages: 2,
		maxSeconds: 20,
		confirmation: receiveDeleteConfirmation('localhost', harness.queue, 'active', ''),
	}
	const result = await harness.host.request('sb.receive-delete', request)
	expect(result).toMatchObject({ received: 2, uncertain: false, cleanupWarning: null })
	expect(result.items).toHaveLength(2)
	expect(await harness.host.request('sb.receive-delete', request)).toEqual(result)
	const snapshotId = result.items[0].snapshotId!
	expect(
		await harness.host.request('sb.body', {
			...harness.request(),
			snapshotId,
			offset: 0,
			count: 65536,
		}),
	).toMatchObject({ base64: 'eA==', totalBytes: 1 })
	expect((await harness.peek()).items).toHaveLength(0)
	const next = await harness.host.request('sb.receive-delete', { ...request, id: randomUUID() })
	expect(next).toMatchObject({ received: 0, uncertain: false })
	await expect(
		harness.host.request('sb.body', {
			...harness.request(),
			snapshotId,
			offset: 0,
			count: 65536,
		}),
	).rejects.toThrow(/snapshot expired/i)
	await evidence('receive-delete', { result, next })
})

it('copies dead letters and then removes originals through two acknowledged connections on one Docker broker', async () => {
	const destination = { kind: 'queue' as const, name: `recovered-${randomUUID()}` }
	expect(
		await harness.observer.request('sb.entity.create', {
			...harness.control(),
			target: destination,
			settings: defaultEntitySettings('queue'),
		}),
	).toMatchObject({ status: 'confirmed' })
	created.push(destination)
	await harness.seed(2)
	for (let index = 0; index < 2; index++) {
		const delivery = (await harness.receive()).items[0]
		expect(
			await harness.host.request('sb.settle', {
				...harness.request(),
				deliveryId: delivery.deliveryId,
				action: 'dead-letter',
				reason: 'MaintenanceCheck',
				description: '',
			}),
		).toMatchObject({ status: 'confirmed' })
	}
	await harness.host.request('sb.close-receiver', harness.request())
	const request = {
		...harness.request(),
		source: harness.queue,
		subQueue: 'dead-letter' as const,
		destination,
		mode: 'keep' as const,
		idPolicy: 'new' as const,
		maxMessages: 2,
		maxSeconds: 30,
	}
	const copied = await harness.host.request('sb.deadletters.resend', request)
	expect(copied).toMatchObject({
		sent: 2,
		removed: 0,
		uncertain: 0,
		crossNamespace: false,
		cleanupWarning: null,
	})
	expect(await harness.host.request('sb.deadletters.resend', request)).toEqual(copied)
	expect((await harness.peek('dead-letter')).items).toHaveLength(2)
	const profile = { ...emulatorProfile(), namespace: 'localhost.' }
	profile.secret = profile.secret.replace('Endpoint=sb://localhost:', 'Endpoint=sb://localhost.:')
	// A loopback DNS alias exercises independent send/complete connections. This is one emulator,
	// not a qualification of Azure namespace isolation, permissions or cross-namespace delivery.
	const recovered = await harness.host.request('sb.deadletters.resend', {
		...request,
		id: randomUUID(),
		mode: 'remove',
		destinationProfileId: profile.id,
		destinationNamespace: profile.namespace,
		destinationProfile: profile,
		acknowledgeNonAtomic: true,
	})
	expect(recovered).toMatchObject({
		sent: 2,
		removed: 2,
		uncertain: 0,
		crossNamespace: true,
		copiedNotRemoved: 0,
		cleanupWarning: null,
	})
	expect(recovered.transfers).toHaveLength(2)
	expect(
		recovered.transfers.every(
			(transfer) => transfer.send === 'confirmed' && transfer.source === 'removed',
		),
	).toBe(true)
	expect((await harness.peek('dead-letter')).items).toHaveLength(0)
	expect(
		(
			await harness.observer.request('sb.peek', {
				...harness.control(),
				target: destination,
				subQueue: 'active',
				fromSequenceNumber: '0',
				maxMessages: 25,
			})
		).items,
	).toHaveLength(4)
	await evidence('recovery', {
		copied,
		recovered,
		topology:
			'Two connections to one Docker broker via localhost and localhost.; Azure namespace isolation remains unqualified.',
	})
})
