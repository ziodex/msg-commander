import { eventGridApi } from '@/features/event-grid/api'

import {
	eventGridNamespace,
	eventGridPath,
	type EventGridPage,
} from '@shared/contracts/event-grid/core'
import type { EventGridState } from '../model/state'
import type { EventGridActions } from '../model/actions'

export function createEventGridBrowsing(
	state: Pick<EventGridState, 'connection' | 'topics' | 'subscriptions' | 'expanded'>,
	actions: Pick<EventGridActions, 'task'>,
) {
	const { connection, topics, subscriptions, expanded } = state
	const { task } = actions
	const merge = (
		old: EventGridPage | undefined,
		value: EventGridPage,
		more: boolean,
	): EventGridPage => {
		const result: EventGridPage = {
			items: more
				? [
						...(old?.items ?? []),
						...value.items.filter(
							(i) =>
								!old?.items.some(
									(v) =>
										eventGridPath(v.target).toLowerCase() ===
										eventGridPath(i.target).toLowerCase(),
								),
						),
					]
				: value.items,
			continuationToken: value.continuationToken,
		}
		const loaded =
			(topics.value?.items.length ?? 0) +
			Object.values(subscriptions.value).reduce((n, p) => n + p.items.length, 0)
		if (
			result.items.length > 1000 ||
			loaded - (old?.items.length ?? 0) + result.items.length > 5000
		)
			throw new Error(
				'Event Grid tree display limit reached (1,000 per parent; 5,000 loaded resources). Refresh or reconnect to browse again.',
			)
		return result
	}
	async function loadTopics(more = false) {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		await task(
			more ? 'Load more Event Grid topics' : 'Refresh Event Grid topics',
			(id) =>
				eventGridApi.listEventGrid({
					id,
					connectionId,
					target: { ...eventGridNamespace },
					continuationToken: more ? (topics.value?.continuationToken ?? null) : null,
				}),
			(value) => {
				topics.value = merge(topics.value, value, more)
				if (!more) {
					const names = new Set(value.items.map((i) => i.name))
					expanded.value = expanded.value.filter((n) => names.has(n))
					subscriptions.value = Object.fromEntries(
						Object.entries(subscriptions.value).filter(([n]) => names.has(n)),
					)
				}
			},
		)
	}
	async function loadSubscriptions(topicName: string, more = false) {
		if (!connection.value) return
		const connectionId = connection.value.connectionId
		await task(
			more ? 'Load more Event Grid subscriptions' : 'Refresh Event Grid subscriptions',
			(id) =>
				eventGridApi.listEventGrid({
					id,
					connectionId,
					target: { kind: 'topic', topicName, subscriptionName: null },
					continuationToken: more
						? (subscriptions.value[topicName]?.continuationToken ?? null)
						: null,
				}),
			(value) => {
				subscriptions.value[topicName] = merge(subscriptions.value[topicName], value, more)
			},
		)
	}
	async function toggle(topicName: string) {
		if (expanded.value.includes(topicName))
			expanded.value = expanded.value.filter((n) => n !== topicName)
		else {
			expanded.value.push(topicName)
			if (!subscriptions.value[topicName]) await loadSubscriptions(topicName)
		}
	}
	return { loadTopics, loadSubscriptions, toggle }
}
