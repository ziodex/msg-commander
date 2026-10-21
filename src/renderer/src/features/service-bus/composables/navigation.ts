import { serviceBusApi } from '@/features/service-bus/api'
import { entityKey } from '@/features/service-bus/lib/entity-counts'
import {
	newEntityTab,
	saveEntityTabs,
	entityTabLimit,
} from '@/features/service-bus/lib/entity-tabs'
import { entityPath } from '@shared/entity-management'

import { type MessageSubQueue } from '@shared/service-bus'

import type { Entity, EntityTarget, EntityDetails } from '@shared/service-bus'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearEntity' | 'clearInspection'>

export function createServiceBusNavigation(
	state: Pick<
		ServiceBusState,
		| 'activeTabId'
		| 'busy'
		| 'category'
		| 'connection'
		| 'currentToken'
		| 'details'
		| 'entities'
		| 'error'
		| 'filter'
		| 'fromSequence'
		| 'history'
		| 'messages'
		| 'pageSize'
		| 'peekedFrom'
		| 'selected'
		| 'selectionView'
		| 'subQueue'
		| 'tabs'
		| 'topicName'
		| 'workspace'
	>,
	actions: ServiceBusDependencies,
) {
	const {
		activeTabId,
		busy,
		category,
		connection,
		currentToken,
		details,
		entities,
		error,
		filter,
		fromSequence,
		history,
		messages,
		pageSize,
		peekedFrom,
		selected,
		selectionView,
		subQueue,
		tabs,
		topicName,
		workspace,
	} = state
	const { clearEntity, clearInspection, task } = actions
	function rememberTab() {
		const tab = tabs.value.find((tab) => tab.id === activeTabId.value)
		if (!tab || !selected.value) return
		Object.assign(tab, {
			entity: selected.value,
			details: details.value,
			messages: messages.value,
			view: selectionView.value,
			subQueue: subQueue.value,
			fromSequence: fromSequence.value,
			peekedFrom: peekedFrom.value,
			pageSize: pageSize.value,
		})
	}
	function persistTabs() {
		if (connection.value) saveEntityTabs(connection.value.profileId, tabs.value)
	}
	async function activateTab(id: string) {
		if (busy.value || !connection.value) return
		const tab = tabs.value.find((tab) => tab.id === id)
		if (!tab || activeTabId.value === id) return
		rememberTab()
		clearInspection()
		selected.value = tab.entity
		category.value = tab.entity.target.kind
		topicName.value =
			tab.entity.target.kind === 'subscription' ? tab.entity.target.topicName : undefined
		details.value = tab.details
		messages.value = tab.messages
		selectionView.value = tab.view
		subQueue.value = tab.subQueue
		fromSequence.value = tab.fromSequence
		peekedFrom.value = tab.peekedFrom
		pageSize.value = tab.pageSize
		error.value = ''
		activeTabId.value = id
		if (!details.value) {
			const connectionId = connection.value.connectionId
			await task(
				'Inspect entity',
				(requestId) =>
					serviceBusApi.getEntity({
						id: requestId,
						connectionId,
						target: { ...tab.entity.target },
					}),
				(value) => {
					details.value = value
				},
			)
		}
	}
	async function closeTab(id: string) {
		if (busy.value) return
		const index = tabs.value.findIndex((tab) => tab.id === id)
		if (index < 0) return
		tabs.value.splice(index, 1)
		persistTabs()
		if (activeTabId.value === id) {
			activeTabId.value = ''
			clearEntity()
			const next = tabs.value[Math.min(index, tabs.value.length - 1)]
			if (next) await activateTab(next.id)
		}
	}
	async function browse(
		kind: 'queue' | 'topic' | 'subscription',
		topic?: string,
		token: string | null = null,
		direction: 'new' | 'next' | 'back' | 'refresh' = 'new',
	) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		await task(
			'Browse ' + (kind === 'subscription' ? 'subscriptions' : kind + 's'),
			(id) =>
				serviceBusApi.listEntities({
					id,
					connectionId,
					kind,
					topicName: topic,
					continuationToken: token,
				}),
			(page) => {
				if (direction === 'next') history.value.push(currentToken.value)
				else if (direction === 'back') history.value.pop()
				else if (direction === 'new') history.value = []
				entities.value = page
				category.value = kind
				topicName.value = topic
				currentToken.value = token
				filter.value = ''
				clearEntity()
			},
		)
	}
	async function refreshEntity(target: EntityTarget) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let refreshed: EntityDetails | undefined
		await task(
			'Refresh entity status',
			(id) => serviceBusApi.getEntity({ id, connectionId, target: { ...target } }),
			(value) => {
				refreshed = value
				if (
					selected.value &&
					entityPath(selected.value.target).toLowerCase() ===
						entityPath(target).toLowerCase() &&
					selected.value.target.kind === target.kind
				) {
					Object.assign(selected.value, value.entity)
					details.value = value
				}
			},
		)
		return refreshed
	}
	async function select(entity: Entity) {
		if (!connection.value || busy.value) return
		const id = entityKey(entity.target)
		if (tabs.value.some((tab) => tab.id === id)) {
			await activateTab(id)
			return
		}
		if (tabs.value.length >= entityTabLimit) {
			error.value = 'Close a tab before opening another (12 maximum).'
			return
		}
		rememberTab()
		clearEntity()
		tabs.value.push(newEntityTab(entity, workspace.preferences.peekCount))
		activeTabId.value = id
		persistTabs()
		selected.value = entity
		const connectionId = connection.value.connectionId
		await task(
			'Inspect entity',
			(id) => serviceBusApi.getEntity({ id, connectionId, target: { ...entity.target } }),
			(value) => {
				details.value = value
			},
		)
	}
	function changeSubQueue(value: MessageSubQueue) {
		if (busy.value) return
		subQueue.value = value
		messages.value = undefined
		fromSequence.value = '0'
		clearInspection()
	}
	return {
		rememberTab,
		persistTabs,
		activateTab,
		closeTab,
		browse,
		refreshEntity,
		select,
		changeSubQueue,
	}
}
