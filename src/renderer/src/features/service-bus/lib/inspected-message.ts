import type { Deliveries, Delivery } from '@shared/message-operations'
import type { EntityTarget, MessageSubQueue, MessageSummary } from '@shared/service-bus'
import { entityKey } from './entity-counts'

export function inspectedDelivery(
	held: Deliveries,
	source: EntityTarget,
	subQueue: MessageSubQueue,
	summary: MessageSummary,
): Delivery | undefined {
	if (!held.target || entityKey(held.target) !== entityKey(source) || held.subQueue !== subQueue)
		return
	// Sequence alone is not an identity across entities/subqueues or entity recreation.
	return held.items.find(
		(item) =>
			item.summary.sequenceNumber === summary.sequenceNumber &&
			item.summary.messageId === summary.messageId &&
			item.summary.enqueuedTime === summary.enqueuedTime &&
			item.summary.sessionId === summary.sessionId,
	)
}
