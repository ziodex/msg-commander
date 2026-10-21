import {
	entitySchema,
	type Entity,
	type EntityDetails,
	type MessageSubQueue,
	type PeekPage,
} from '@shared/service-bus'
import { entityKey } from './entity-counts'

export type EntityTab = {
	id: string
	entity: Entity
	details?: EntityDetails
	messages?: PeekPage
	view: 'entity' | 'messages'
	subQueue: MessageSubQueue
	fromSequence: string
	peekedFrom: string
	pageSize: number
}
export const entityTabLimit = 12
export function newEntityTab(entity: Entity, pageSize: number): EntityTab {
	return {
		id: entityKey(entity.target),
		entity,
		view: 'entity',
		subQueue: 'active',
		fromSequence: '0',
		peekedFrom: '0',
		pageSize,
	}
}
export function readEntityTabs(profileId: string, pageSize: number): EntityTab[] {
	try {
		const saved: unknown = JSON.parse(
			localStorage.getItem('commander-entity-tabs:' + profileId) ?? '[]',
		)
		if (!Array.isArray(saved) || saved.length > entityTabLimit) return []
		const tabs = saved.map((value) => newEntityTab(entitySchema.parse(value), pageSize))
		return [...new Map(tabs.map((tab) => [tab.id, tab])).values()]
	} catch {
		return []
	}
}
export function saveEntityTabs(profileId: string, tabs: EntityTab[]) {
	try {
		// Only entity metadata survives a restart. Message bodies, snapshots and broker handles do not.
		localStorage.setItem(
			'commander-entity-tabs:' + profileId,
			JSON.stringify(tabs.map((tab) => tab.entity)),
		)
	} catch {
		// Optional workspace preference.
	}
}
