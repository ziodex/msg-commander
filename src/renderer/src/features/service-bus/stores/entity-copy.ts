import { serviceBusApi } from '@/features/service-bus/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DesktopResult } from '@shared/contracts'
import type { OperationOutcome } from '@shared/message-operations'
import type {
	EntityCopySpec,
	EntityCopyPreview,
	EntityCopyResult,
	EntityRenameReview,
} from '@shared/entity-copy'
import { useServiceBus } from './service-bus'
import { useWorkspace } from '../../../shared/workspace/store'

export const useEntityCopy = defineStore('entity-copy', () => {
	const sb = useServiceBus(),
		workspace = useWorkspace()
	const preview = ref<EntityCopyPreview>(),
		history = ref<EntityCopyResult[]>([]),
		currentId = ref(''),
		review = ref<EntityRenameReview>()
	const removals = ref<Record<string, OperationOutcome>>({}),
		error = ref('')
	const result = computed(() =>
		history.value.find((item) => item.operationId === currentId.value),
	)
	const removal = computed(() => removals.value[currentId.value])
	const unresolved = computed(
		() =>
			history.value.some((item) => ['unknown', 'partial', 'running'].includes(item.status)) ||
			Object.values(removals.value).some((item) => item.status === 'unknown'),
	)
	let generation = 0
	watch(
		() => sb.connection?.connectionId,
		() => {
			generation++
			preview.value = undefined
			history.value = []
			currentId.value = ''
			review.value = undefined
			removals.value = {}
			error.value = ''
		},
		{ flush: 'sync' },
	)
	async function run<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<T | undefined> {
		if (!sb.connection || sb.busy) return
		const ticket = generation
		sb.busy = label
		error.value = ''
		try {
			const value = await workspace.perform(label, action, report)
			return ticket === generation ? value : undefined
		} catch (cause) {
			if (ticket === generation)
				error.value = cause instanceof Error ? cause.message : 'Copy/rename request failed.'
		} finally {
			if (ticket === generation) sb.busy = ''
		}
	}
	function remember(value: EntityCopyResult) {
		history.value = [
			value,
			...history.value.filter((item) => item.operationId !== value.operationId),
		].slice(0, 20)
		currentId.value = value.operationId
	}
	function select(id: string) {
		currentId.value = id
		review.value = undefined
		preview.value = undefined
		error.value = ''
	}
	function clearPreview() {
		preview.value = undefined
	}
	function startNew() {
		if (unresolved.value) return false
		preview.value = undefined
		currentId.value = ''
		review.value = undefined
		error.value = ''
		return true
	}
	async function prepare(spec: EntityCopySpec) {
		if (!sb.connection || unresolved.value) return
		const connectionId = sb.connection.connectionId
		preview.value = undefined
		const value = await run('Preview entity copy', (id) =>
			serviceBusApi.previewEntityCopy({
				id,
				connectionId,
				spec: JSON.parse(JSON.stringify(spec)) as EntityCopySpec,
			}),
		)
		if (value) preview.value = value
	}
	function report(value: EntityCopyResult | OperationOutcome) {
		return {
			status:
				value.status === 'confirmed'
					? ('completed' as const)
					: value.status === 'cancelled'
						? ('cancelled' as const)
						: ('failed' as const),
			message: `${value.summary} Receipt: ${value.operationId}`,
		}
	}
	async function execute(confirmation: string) {
		if (!sb.connection || !preview.value || unresolved.value) return
		const connectionId = sb.connection.connectionId,
			plan = JSON.parse(JSON.stringify(preview.value)) as EntityCopyPreview
		const value = await run<EntityCopyResult>(
			'Copy entity configuration',
			async (id) => {
				try {
					const response = await serviceBusApi.executeEntityCopy({
						id,
						connectionId,
						planId: plan.planId,
						confirmation,
					})
					if (
						response.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
						].includes(response.error.code)
					)
						return response
				} catch {
					// A lost IPC response cannot establish rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						planId: plan.planId,
						spec: plan.spec,
						status: 'unknown',
						steps: [],
						summary:
							'Copy outcome is unknown. Inspect the host receipt and destination before any new attempt. No automatic retry was made.',
						canFinishRename: false,
					},
				}
			},
			report,
		)
		if (value) {
			remember(value)
			preview.value = undefined
		}
	}
	async function check() {
		if (!sb.connection || !result.value) return
		const connectionId = sb.connection.connectionId,
			operationId = result.value.operationId
		const value = await run('Check entity copy receipt', (id) =>
			serviceBusApi.getEntityCopyResult({ id, connectionId, operationId }),
		)
		if (value) remember(value)
		else if (value === null)
			error.value =
				'No receipt is available. Inspect Azure; a missing receipt does not prove failure.'
	}
	async function reviewSource() {
		if (!sb.connection || !result.value?.canFinishRename || unresolved.value) return
		const connectionId = sb.connection.connectionId,
			operationId = result.value.operationId
		review.value = undefined
		const value = await run('Review renamed source removal', (id) =>
			serviceBusApi.reviewEntityRename({ id, connectionId, operationId }),
		)
		if (value) review.value = value
	}
	async function finish(confirmation: string) {
		if (!sb.connection || !review.value || review.value.blockers.length || unresolved.value)
			return
		const connectionId = sb.connection.connectionId,
			reviewId = review.value.reviewId,
			copyId = currentId.value
		const value = await run<OperationOutcome>(
			'Remove renamed source',
			async (id) => {
				try {
					const response = await serviceBusApi.finishEntityRename({
						id,
						connectionId,
						reviewId,
						confirmation,
					})
					if (
						response.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
						].includes(response.error.code)
					)
						return response
				} catch {
					// Keep an uncertain deletion visible until the receipt is checked.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown',
						summary:
							'Source removal outcome is unknown. Inspect Azure and this receipt; the destination was retained.',
						messageId: null,
					},
				}
			},
			report,
		)
		if (value) {
			removals.value[copyId] = value
			review.value = undefined
			if (['confirmed', 'unknown'].includes(value.status) && result.value)
				remember({ ...result.value, canFinishRename: false })
			await check()
		}
	}
	async function checkRemoval() {
		if (!sb.connection || !removal.value) return
		const connectionId = sb.connection.connectionId,
			operationId = removal.value.operationId,
			copyId = currentId.value
		const value = await run('Check source removal receipt', (id) =>
			serviceBusApi.getEntityRenameResult({ id, connectionId, operationId }),
		)
		if (value) {
			removals.value[copyId] = value
			await check()
		} else if (value === null)
			error.value =
				'No source-removal receipt is available. Inspect Azure before another action.'
	}
	return {
		preview,
		history,
		result,
		review,
		removal,
		error,
		unresolved,
		startNew,
		select,
		clearPreview,
		prepare,
		execute,
		check,
		reviewSource,
		finish,
		checkRemoval,
	}
})
