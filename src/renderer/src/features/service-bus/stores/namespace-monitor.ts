import { serviceBusApi } from '@/features/service-bus/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { RuntimeEntity, EntityTarget, ListRequest } from '@shared/service-bus'
import { entityKey, totalCounts } from '@/features/service-bus/lib/entity-counts'
import { useServiceBus } from './service-bus'
import { useWorkspace } from '../../../shared/workspace/store'

export const useNamespaceMonitor = defineStore('namespace-monitor', () => {
	const sb = useServiceBus()
	const workspace = useWorkspace()
	const rows = ref<RuntimeEntity[]>([]),
		refreshing = ref(false),
		updatedAt = ref(''),
		issues = ref<string[]>([]),
		complete = ref(false),
		stale = ref(false),
		scanned = ref(0)
	const interval = ref(workspace.preferences.countRefreshSeconds)
	const totals = computed(() => totalCounts(rows.value, complete.value))
	const byEntity = computed(
		() => new Map(rows.value.map((row) => [entityKey(row.target), row.counts])),
	)
	let timer: ReturnType<typeof setTimeout> | undefined,
		enabled = false,
		generation = 0,
		pending: string | undefined
	let interrupted = false
	const counts = (target: EntityTarget) => byEntity.value.get(entityKey(target))
	function updateEntity(row: RuntimeEntity) {
		// Do not let an older in-flight namespace scan overwrite an explicit refresh.
		if (refreshing.value) cancel()
		const index = rows.value.findIndex(
			(item) => entityKey(item.target) === entityKey(row.target),
		)
		if (index >= 0) rows.value[index] = row
		else {
			rows.value.push(row)
			complete.value = false
		}
	}
	function cancel() {
		interrupted = true
		if (pending) void serviceBusApi.cancelOperation(pending).catch(() => {})
		if (updatedAt.value) stale.value = true
	}
	function schedule() {
		clearTimeout(timer)
		if (
			enabled &&
			sb.connection &&
			interval.value > 0 &&
			workspace.preferences.showMessageCounts
		)
			timer = setTimeout(() => void refresh(), (updatedAt.value ? interval.value : 1) * 1000)
	}
	async function refresh() {
		if (!enabled || !sb.connection || refreshing.value) return
		clearTimeout(timer)
		if (sb.busy || document.hidden) {
			schedule()
			return
		}
		const connectionId = sb.connection.connectionId,
			ticket = generation
		refreshing.value = true
		interrupted = false
		scanned.value = 0
		const next = new Map<string, RuntimeEntity>(),
			warnings: string[] = []
		let requests = 0
		const valid = () =>
			ticket === generation && !interrupted && enabled && !sb.busy && !document.hidden
		async function feed(kind: EntityTarget['kind'], topicName?: string) {
			const tokens = new Set<string>()
			let continuationToken: string | null = null
			do {
				if (!valid()) throw new Error('interrupted')
				if (++requests > 1000 || next.size >= 10000) throw new Error('limit')
				const id = crypto.randomUUID()
				pending = id
				const response = await serviceBusApi.listRuntimeCounts({
					id,
					connectionId,
					kind,
					topicName,
					continuationToken,
				} as ListRequest)
				if (pending === id) pending = undefined
				if (!valid()) throw new Error('interrupted')
				if (!response.ok) {
					warnings.push(
						`${topicName ? `Subscriptions in ${topicName}` : kind === 'queue' ? 'Queues' : 'Topics'}: counts unavailable.`,
					)
					return
				}
				for (const item of response.value.items) {
					if (
						item.target.kind !== kind ||
						(kind === 'subscription' &&
							item.target.kind === 'subscription' &&
							item.target.topicName.toLowerCase() !== topicName?.toLowerCase())
					)
						throw new Error('scope')
					const key = entityKey(item.target)
					if (next.has(key)) throw new Error('paging')
					if (next.size >= 10000) throw new Error('limit')
					next.set(key, item)
				}
				scanned.value = next.size
				continuationToken = response.value.continuationToken
				if (continuationToken && tokens.has(continuationToken)) throw new Error('paging')
				if (continuationToken) tokens.add(continuationToken)
			} while (continuationToken)
		}
		try {
			await feed('queue')
			await feed('topic')
			for (const row of [...next.values()])
				if (row.target.kind === 'topic') await feed('subscription', row.target.name)
			if (valid()) {
				rows.value = [...next.values()]
				complete.value = warnings.length === 0
				issues.value = warnings
				updatedAt.value = new Date().toISOString()
				stale.value = false
			}
		} catch (error) {
			if (ticket === generation && !interrupted) {
				stale.value = true
				issues.value = [
					error instanceof Error && error.message === 'limit'
						? 'Namespace scan reached its 10,000-entity / 1,000-page limit. Previous counts are retained.'
						: 'Count refresh did not finish. Previous counts are retained; refresh to try again.',
				]
			}
		} finally {
			if (ticket === generation) {
				refreshing.value = false
				pending = undefined
				schedule()
			}
		}
	}
	function start() {
		enabled = true
		if (workspace.preferences.showMessageCounts) void refresh()
		document.addEventListener('visibilitychange', visibility)
	}
	function stop() {
		enabled = false
		clearTimeout(timer)
		cancel()
		document.removeEventListener('visibilitychange', visibility)
	}
	function visibility() {
		if (document.hidden) cancel()
		else if (interval.value && workspace.preferences.showMessageCounts) void refresh()
	}
	watch(interval, () => {
		if (!interval.value) cancel()
		schedule()
	})
	watch(
		() => workspace.preferences.countRefreshSeconds,
		(value) => {
			interval.value = value
		},
	)
	watch(
		() => workspace.preferences.showMessageCounts,
		(value) => {
			if (!value) {
				cancel()
				clearTimeout(timer)
			} else if (enabled) void refresh()
		},
	)
	watch(
		() => sb.busy,
		(value) => {
			if (value && refreshing.value) cancel()
		},
		{ flush: 'sync' },
	)
	watch(
		() => sb.connection?.connectionId,
		() => {
			cancel()
			generation++
			pending = undefined
			refreshing.value = false
			rows.value = []
			updatedAt.value = ''
			issues.value = []
			complete.value = false
			stale.value = false
			scanned.value = 0
			clearTimeout(timer)
			if (enabled && workspace.preferences.showMessageCounts) void refresh()
		},
		{ flush: 'sync' },
	)
	return {
		rows,
		totals,
		counts,
		updateEntity,
		interval,
		refreshing,
		updatedAt,
		issues,
		complete,
		stale,
		scanned,
		refresh,
		start,
		stop,
	}
})
