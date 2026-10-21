import { expect, it } from 'vitest'
import { inspectedDelivery } from '../../src/renderer/src/features/service-bus/lib/inspected-message'
import type { Deliveries, Delivery } from '../../src/shared/message-operations'
const source = { kind: 'subscription' as const, topicName: 'events', name: 'audit' }
const delivery: Delivery = {
	deliveryId: 'owned-id',
	state: 'active',
	lockedUntil: '2030-01-01T00:00:00Z',
	summary: {
		snapshotId: 'held-snapshot',
		sequenceNumber: '9007199254740993',
		messageId: 'same-id',
		subject: null,
		contentType: null,
		sessionId: 'session',
		enqueuedTime: '2026-01-01T00:00:00Z',
		state: 'Active',
		bodySize: 1,
		deliveryCount: 1,
		inspectionWarning: null,
	},
}
const held: Deliveries = {
	target: source,
	subQueue: 'dead-letter',
	sessionId: null,
	items: [delivery],
	warning: null,
}
it('matches a peeked message to an owned handle only in the exact source and subqueue', () => {
	const summary = { ...delivery.summary, snapshotId: 'peek-snapshot' }
	expect(inspectedDelivery(held, source, 'dead-letter', summary)).toBe(delivery)
	expect(
		inspectedDelivery(held, { ...source, topicName: 'other' }, 'dead-letter', summary),
	).toBeUndefined()
	expect(inspectedDelivery(held, source, 'active', summary)).toBeUndefined()
	for (const key of ['sequenceNumber', 'messageId', 'enqueuedTime', 'sessionId'] as const)
		expect(
			inspectedDelivery(held, source, 'dead-letter', { ...summary, [key]: 'other' }),
		).toBeUndefined()
})
