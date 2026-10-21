import { z } from 'zod'
import {
	eventHubNameSchema,
	consumerGroupSchema,
	type EventHubInfo,
	type EventHubsPage,
	type EventHubPartition,
	type EventHubReadResult,
} from '@shared/contracts/event-hubs/core'
const tabSchema = z
	.object({
		hubName: eventHubNameSchema,
		partitionId: z.string().max(64).regex(/^\d*$/),
		consumerGroup: consumerGroupSchema,
	})
	.strict()
export type EventTab = z.infer<typeof tabSchema> & {
	id: string
	hub?: EventHubInfo
	groups?: EventHubsPage
	partition?: EventHubPartition
	result?: EventHubReadResult
	readId?: string
	readConsumerGroup?: string
	interrupted?: boolean
}
export const eventTabKey = (hubName: string, partitionId = '', consumerGroup = '$Default') =>
	JSON.stringify([hubName, partitionId, consumerGroup])
export function readEventTabs(profileId: string): EventTab[] {
	try {
		return z
			.array(tabSchema)
			.max(12)
			.parse(JSON.parse(localStorage.getItem('commander-event-tabs:' + profileId) ?? '[]'))
			.map((tab) => ({
				...tab,
				id: eventTabKey(tab.hubName, tab.partitionId, tab.consumerGroup),
			}))
	} catch {
		return []
	}
}
export function saveEventTabs(profileId: string, tabs: EventTab[]) {
	try {
		localStorage.setItem(
			'commander-event-tabs:' + profileId,
			JSON.stringify(
				tabs.map(({ hubName, partitionId, consumerGroup }) => ({
					hubName,
					partitionId,
					consumerGroup,
				})),
			),
		)
	} catch {
		// Optional metadata only.
	}
}
