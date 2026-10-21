import { serviceBusApi } from '@/features/service-bus/api'
import { bulkEntityKey } from '@shared/bulk-entities'
import type { MessageSubQueue } from '@shared/service-bus'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Entity, EntityPage, EntityTarget } from '@shared/service-bus'
import { branchKey, entityKey } from '@/features/service-bus/lib/entity-counts'
import { useNamespaceMonitor } from './namespace-monitor'
import { useServiceBus } from './service-bus'
type Branch = EntityPage & { loading: boolean; loaded: boolean; error: string }
export const useEntityTree = defineStore('entity-tree', () => {
	const sb = useServiceBus(),
		branches = ref<Record<string, Branch>>({}),
		expanded = ref<Record<string, boolean>>({ queue: true, topic: true }),
		filter = ref(''),
		expandingAll = ref(false),
		expansionError = ref('')
	const selectionMode = ref(false),
		selectedTargets = ref<EntityTarget[]>([]),
		selectionBusy = ref(false),
		selectionError = ref('')
	let selectionGeneration = 0
	let selectionRequest: string | undefined
	const folderKey = (kind: string, prefix: string) => `folder:${kind}:${prefix}`
	function isChecked(target: EntityTarget) {
		return selectedTargets.value.some((item) => bulkEntityKey(item) === bulkEntityKey(target))
	}
	function toggleChecked(target: EntityTarget) {
		if (sb.busy || selectionBusy.value) return
		selectionMode.value = true
		selectionError.value = ''
		if (isChecked(target))
			selectedTargets.value = selectedTargets.value.filter(
				(item) => bulkEntityKey(item) !== bulkEntityKey(target),
			)
		else if (selectedTargets.value.length < 100) selectedTargets.value.push({ ...target })
		else selectionError.value = 'Select at most 100 entities per job.'
	}
	function cancelSelection() {
		selectionGeneration++
		selectionBusy.value = false
		if (selectionRequest) void serviceBusApi.cancelOperation(selectionRequest).catch(() => {})
		selectionRequest = undefined
	}
	// Folder/category selection always enumerates every page. Filters and loaded pages do not define scope.
	async function selectScope(kind: EntityTarget['kind'], prefix = '', topicName?: string) {
		if (!sb.connection || sb.busy || selectionBusy.value) return
		selectionMode.value = true
		selectionBusy.value = true
		selectionError.value = ''
		const ticket = ++selectionGeneration,
			connectionId = sb.connection.connectionId
		const chosen = new Map(
			selectedTargets.value.map((target) => [bulkEntityKey(target), target]),
		)
		const tokens = new Set<string>()
		let token: string | null = null,
			pages = 0
		try {
			do {
				if (++pages > 1000)
					throw new Error('Selection exceeded 1,000 pages. Select a smaller folder.')
				const id = crypto.randomUUID()
				selectionRequest = id
				const response = await serviceBusApi.listEntities({
					id,
					connectionId,
					kind,
					topicName,
					continuationToken: token,
				})
				if (ticket !== selectionGeneration) return
				if (!response.ok) throw new Error(response.error.message)
				for (const item of response.value.items) {
					if (
						item.target.kind !== kind ||
						(item.target.kind === 'subscription' &&
							item.target.topicName.toLowerCase() !== topicName?.toLowerCase())
					)
						throw new Error(
							'The listing returned an unexpected scope. Selection was not changed.',
						)
					if (
						prefix &&
						!item.target.name.toLowerCase().startsWith(prefix.toLowerCase() + '/')
					)
						continue
					chosen.set(bulkEntityKey(item.target), { ...item.target })
					if (chosen.size > 100)
						throw new Error(
							'This scope exceeds 100 selected entities. Select a smaller folder or individual entities.',
						)
				}
				token = response.value.continuationToken
				if (token && tokens.has(token))
					throw new Error('Paging did not advance. Selection was not changed.')
				if (token) tokens.add(token)
			} while (token)
			if (ticket === selectionGeneration) selectedTargets.value = [...chosen.values()]
		} catch (error) {
			if (ticket === selectionGeneration)
				selectionError.value =
					error instanceof Error
						? error.message
						: 'Could not select the whole scope. Selection was not changed.'
		} finally {
			if (ticket === selectionGeneration) {
				selectionBusy.value = false
				selectionRequest = undefined
			}
		}
	}
	let generation = 0
	let expansionGeneration = 0
	let expansionRequest: string | undefined
	const pending = new Set<string>()
	const loading = computed(() => Object.values(branches.value).some((value) => value.loading))
	function branch(kind: EntityTarget['kind'], topic?: string): Branch {
		return (branches.value[branchKey(kind, topic)] ??= {
			items: [],
			continuationToken: null,
			loading: false,
			loaded: false,
			error: '',
		})
	}
	async function load(
		kind: EntityTarget['kind'],
		topic?: string,
		more = false,
		forExpansion = false,
	) {
		if (!sb.connection) return false
		const value = branch(kind, topic)
		if (value.loading || (more && !value.continuationToken)) return false
		const connectionId = sb.connection.connectionId,
			ticket = generation,
			expansionTicket = expansionGeneration,
			id = crypto.randomUUID()
		value.loading = true
		value.error = ''
		pending.add(id)
		if (forExpansion) expansionRequest = id
		try {
			const response = await serviceBusApi.listEntities({
				id,
				connectionId,
				kind,
				topicName: topic,
				continuationToken: more ? value.continuationToken : null,
			})
			if (ticket !== generation || (forExpansion && expansionTicket !== expansionGeneration))
				return false
			if (!response.ok) {
				value.error = response.error.message
				return false
			}
			const page = response.value
			if (
				more &&
				page.continuationToken &&
				page.continuationToken === value.continuationToken
			) {
				value.error = 'Paging did not advance. Refresh this branch.'
				return false
			}
			value.items = [
				...new Map(
					[...(more ? value.items : []), ...page.items].map((item) => [
						entityKey(item.target),
						item,
					]),
				).values(),
			]
			value.continuationToken = page.continuationToken
			for (const entity of value.items) {
				if (entity.target.kind === 'subscription') continue
				const parts = entity.target.name.split('/')
				for (let index = 1; index < parts.length; index++) {
					const key = folderKey(entity.target.kind, parts.slice(0, index).join('/'))
					if (expanded.value[key] === undefined) expanded.value[key] = true
				}
			}
			value.loaded = true
			return true
		} catch {
			if (ticket === generation)
				value.error = 'Could not load this branch. Try refreshing it.'
			return false
		} finally {
			pending.delete(id)
			if (expansionRequest === id) expansionRequest = undefined
			if (ticket === generation) value.loading = false
		}
	}
	async function expandTopic(name: string) {
		expanded.value.topic = true
		expanded.value[entityKey({ kind: 'topic', name })] = true
		if (!branch('subscription', name).loaded) await load('subscription', name)
		sb.category = 'subscription'
		sb.topicName = name
	}
	async function toggle(entity: Entity) {
		stopExpanding()
		const key = entityKey(entity.target)
		expanded.value[key] = !expanded.value[key]
		if (entity.target.kind === 'topic' && expanded.value[key])
			await expandTopic(entity.target.name)
	}
	function stopExpanding() {
		expansionGeneration++
		expandingAll.value = false
		if (expansionRequest) void serviceBusApi.cancelOperation(expansionRequest).catch(() => {})
		expansionRequest = undefined
	}
	function collapseAll() {
		stopExpanding()
		expanded.value = Object.fromEntries(
			Object.keys(expanded.value)
				.filter((key) => key.startsWith('folder:'))
				.map((key) => [key, false]),
		)
		expanded.value.queue = expanded.value.topic = false
		expansionError.value = ''
	}
	async function expandAll() {
		if (!sb.connection || sb.busy || loading.value || expandingAll.value) return
		const ticket = ++expansionGeneration
		expandingAll.value = true
		expansionError.value = ''
		let requests = 0,
			entities = 0
		const valid = () => ticket === expansionGeneration && !!sb.connection && !sb.busy
		async function allPages(kind: EntityTarget['kind'], topic?: string) {
			const value = branch(kind, topic),
				tokens = new Set<string>()
			while (valid() && (!value.loaded || value.continuationToken)) {
				if (++requests > 1000) throw new Error('limit')
				if (value.continuationToken) {
					if (tokens.has(value.continuationToken)) throw new Error('paging')
					tokens.add(value.continuationToken)
				}
				if (!(await load(kind, topic, value.loaded, true))) throw new Error('load')
				if (entities + value.items.length > 10000) throw new Error('limit')
			}
			if (!valid()) return
			entities += value.items.length
			if (entities > 10000) throw new Error('limit')
			for (const entity of value.items) {
				expanded.value[entityKey(entity.target)] = true
				if (entity.target.kind !== 'subscription') {
					const segments = entity.target.name.split('/')
					for (let i = 1; i < segments.length; i++)
						expanded.value[
							folderKey(entity.target.kind, segments.slice(0, i).join('/'))
						] = true
				}
			}
		}
		try {
			expanded.value.queue = expanded.value.topic = true
			await allPages('queue')
			await allPages('topic')
			for (const entity of branch('topic').items) {
				if (!valid()) break
				await allPages('subscription', entity.target.name)
			}
		} catch (error) {
			if (valid())
				expansionError.value =
					error instanceof Error && error.message === 'limit'
						? 'Expansion stopped at the 10,000-entity / 1,000-page limit. Open individual branches to continue.'
						: 'Some branches could not be expanded. Retry the affected branch or Expand all again.'
		} finally {
			if (ticket === expansionGeneration) expandingAll.value = false
		}
	}
	async function select(entity: Entity, subQueue?: MessageSubQueue) {
		if (sb.busy) return
		sb.category = entity.target.kind
		sb.topicName = entity.target.kind === 'subscription' ? entity.target.topicName : undefined
		await sb.select(entity)
		if (subQueue && sb.selected && entityKey(sb.selected.target) === entityKey(entity.target)) {
			sb.changeSubQueue(subQueue)
			await sb.peek()
		}
	}
	async function refreshEntity(target: EntityTarget) {
		if (!sb.connection || sb.busy) return
		const connectionId = sb.connection.connectionId
		const details = await sb.refreshEntity(target)
		if (!details || sb.connection?.connectionId !== connectionId) return
		const value = branch(
			target.kind,
			target.kind === 'subscription' ? target.topicName : undefined,
		)
		const index = value.items.findIndex((item) => entityKey(item.target) === entityKey(target))
		if (index >= 0) value.items[index] = details.entity
		useNamespaceMonitor().updateEntity({
			target: details.entity.target,
			counts: details.counts,
		})
		if (target.kind === 'topic' && branch('subscription', target.name).loaded)
			await load('subscription', target.name)
	}
	async function refresh() {
		if (sb.busy) return
		await load('queue')
		await load('topic')
		for (const entity of branch('topic').items)
			if (expanded.value[entityKey(entity.target)])
				await load('subscription', entity.target.name)
	}
	function reset() {
		stopExpanding()
		cancelSelection()
		selectedTargets.value = []
		selectionMode.value = false
		selectionError.value = ''
		expansionError.value = ''
		generation++
		for (const id of pending) void serviceBusApi.cancelOperation(id).catch(() => {})
		pending.clear()
		branches.value = {}
		expanded.value = { queue: true, topic: true }
		filter.value = ''
	}
	watch(() => sb.connection?.connectionId, reset, { flush: 'sync' })
	watch(
		() => sb.busy,
		(value) => {
			if (value && selectionBusy.value) {
				cancelSelection()
				selectionError.value =
					'Selection paused for the current operation. Select the scope again to continue.'
			}
			if (value && expandingAll.value) {
				stopExpanding()
				expansionError.value =
					'Expansion paused for the current operation. Choose Expand all to continue.'
			}
		},
		{ flush: 'sync' },
	)
	// Entity edits/copies still use the shared browser to refresh their scope. Merge that result into the tree.
	watch(
		() => sb.entities,
		(page) => {
			if (!sb.connection) return
			const value = branch(sb.category, sb.topicName)
			value.items = sb.currentToken
				? [
						...new Map(
							[...value.items, ...page.items].map((item) => [
								entityKey(item.target),
								item,
							]),
						).values(),
					]
				: [...page.items]
			value.continuationToken = page.continuationToken
			value.loaded = true
			value.error = ''
			if (sb.category === 'subscription' && sb.topicName) {
				expanded.value.topic = true
				expanded.value[entityKey({ kind: 'topic', name: sb.topicName })] = true
			}
		},
		{ flush: 'post', immediate: true },
	)
	return {
		selectionMode,
		selectedTargets,
		selectionBusy,
		selectionError,
		isChecked,
		toggleChecked,
		selectScope,
		cancelSelection,
		folderKey,
		branches,
		expanded,
		filter,
		branch,
		load,
		expandTopic,
		toggle,
		select,
		refresh,
		refreshEntity,
		expandingAll,
		expansionError,
		loading,
		expandAll,
		collapseAll,
		stopExpanding,
	}
})
