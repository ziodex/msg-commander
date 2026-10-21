import { serviceBusJob } from '@/features/service-bus/operation-progress'
import { serviceBusApi } from '@/features/service-bus/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DesktopResult } from '@shared/contracts'
import type { BulkEntityAction, BulkEntityPlan, BulkEntityResult } from '@shared/bulk-entities'
import { bulkEntityKey } from '@shared/bulk-entities'
import type { EntityTarget } from '@shared/service-bus'
import { useServiceBus } from './service-bus'
import { useWorkspace } from '../../../shared/workspace/store'
import { useEntityTree } from './entity-tree'
import { useNamespaceMonitor } from './namespace-monitor'

export const useBulkEntities = defineStore('bulk-entities', () => {
	const sb = useServiceBus(),
		workspace = useWorkspace(),
		tree = useEntityTree(),
		monitor = useNamespaceMonitor()
	const plan = ref<BulkEntityPlan>(),
		result = ref<BulkEntityResult>(),
		operationId = ref(''),
		error = ref('')
	const interrupted = ref(false),
		needsReview = ref(false)
	const unresolved = computed(() => interrupted.value || needsReview.value)
	const job = computed(() =>
		serviceBusJob(workspace.jobs.find((item) => item.id === operationId.value)),
	)
	let generation = 0
	watch(
		() => sb.connection?.connectionId,
		() => {
			generation++
			plan.value = undefined
			result.value = undefined
			operationId.value = ''
			error.value = ''
			interrupted.value = needsReview.value = false
		},
		{ flush: 'sync' },
	)
	async function run<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		report?: Parameters<typeof workspace.perform<T>>[2],
	) {
		if (!sb.connection || sb.busy) return
		const ticket = generation
		sb.busy = label
		error.value = ''
		try {
			const value = await workspace.perform(label, action, report)
			if (ticket === generation) return value
		} catch (cause) {
			if (ticket === generation)
				error.value = cause instanceof Error ? cause.message : 'Bulk entity request failed.'
		} finally {
			if (ticket === generation) sb.busy = ''
		}
	}
	async function prepare(targets: EntityTarget[], action: BulkEntityAction, maxSeconds: number) {
		if (!sb.connection || unresolved.value) return false
		const connectionId = sb.connection.connectionId
		plan.value = undefined
		result.value = undefined
		operationId.value = ''
		const value = await run('Review bulk entity actions', (id) =>
			serviceBusApi.previewBulkEntities({
				id,
				connectionId,
				targets: JSON.parse(JSON.stringify(targets)),
				action: { ...action },
				maxSeconds,
			}),
		)
		if (value) plan.value = value
		return !!value
	}
	function remember(value: BulkEntityResult) {
		result.value = value
		plan.value = value.plan
		interrupted.value = false
		needsReview.value = value.status === 'unknown'
		// Update all cached pages immediately so deleted/stale entities cannot remain selected.
		const confirmed = value.items.filter((row) => row.status === 'confirmed')
		const affected = (target: EntityTarget) =>
			confirmed.some(
				(row) =>
					bulkEntityKey(row.target) === bulkEntityKey(target) ||
					(value.plan.action.kind === 'delete' &&
						row.target.kind === 'topic' &&
						target.kind === 'subscription' &&
						row.target.name.toLowerCase() === target.topicName.toLowerCase()),
			)
		for (const branch of Object.values(tree.branches)) {
			if (value.plan.action.kind === 'delete')
				branch.items = branch.items.filter((item) => !affected(item.target))
			else {
				const status = value.plan.action.status
				branch.items = branch.items.map((item) =>
					affected(item.target) ? { ...item, status } : item,
				)
			}
		}
		if (sb.selected && affected(sb.selected.target)) sb.clearEntity()
		tree.selectedTargets = tree.selectedTargets.filter((target) => !affected(target))
		monitor.stale = true
		void monitor.refresh()
	}
	async function execute(confirmation: string) {
		if (!sb.connection || !plan.value || unresolved.value || sb.busy) return
		const connectionId = sb.connection.connectionId,
			planId = plan.value.planId,
			ticket = generation
		const value = await run(
			'Apply bulk entity actions',
			async (id) => {
				operationId.value = id
				try {
					const response = await serviceBusApi.executeBulkEntities({
						id,
						connectionId,
						planId,
						confirmation,
					})
					if (
						ticket === generation &&
						!response.ok &&
						['OUTCOME_UNKNOWN', 'TIMEOUT', 'CANCELLED', 'BACKEND_UNAVAILABLE'].includes(
							response.error.code,
						)
					)
						interrupted.value = true
					return response
				} catch (cause) {
					if (ticket === generation) interrupted.value = true
					throw cause
				}
			},
			(value) => ({
				status:
					value.status === 'completed'
						? 'completed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: `${value.summary} Receipt: ${value.operationId}`,
			}),
		)
		if (value) remember(value)
	}
	async function check() {
		if (!sb.connection || !operationId.value) return
		const connectionId = sb.connection.connectionId,
			current = operationId.value
		const value = await run('Check bulk entity receipt', (id) =>
			serviceBusApi.getBulkEntityResult({ id, connectionId, operationId: current }),
		)
		if (value) remember(value)
		else if (value === null)
			error.value =
				'No receipt is available. Inspect Azure; a missing receipt does not prove that nothing changed.'
	}
	function startNew() {
		if (unresolved.value || sb.busy) return
		plan.value = undefined
		result.value = undefined
		operationId.value = ''
		error.value = ''
	}
	return {
		plan,
		result,
		operationId,
		error,
		interrupted,
		needsReview,
		unresolved,
		job,
		prepare,
		execute,
		check,
		startNew,
	}
})
