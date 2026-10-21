import { eventHubsApi } from '@/features/event-hubs/api'
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useEventHubs } from './event-hubs'
import type { DesktopResult } from '@shared/contracts'
import type {
	EventAdminChange,
	EventAdminContext,
	EventAdminOutcome,
	EventAdminTarget,
	EventPolicyKeyRequest,
} from '@shared/contracts/event-hubs/administration'
export const useEventHubsAdmin = defineStore('event-hubs-admin', () => {
	const eh = useEventHubs(),
		context = ref<EventAdminContext>(),
		outcome = ref<EventAdminOutcome>(),
		reviewed = ref(false)
	const blocked = computed(
		() => !!eh.busy || (outcome.value?.status === 'unknown' && !reviewed.value),
	)
	watch(
		() => eh.connection?.connectionId,
		() => {
			context.value = undefined
			outcome.value = undefined
			reviewed.value = false
		},
		{ flush: 'sync' },
	)
	async function run<T>(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
		report?: Parameters<typeof eh.task<T>>[3],
	): Promise<T | undefined> {
		if (!eh.connection || eh.busy) return
		const connectionId = eh.connection.connectionId
		let result: T | undefined
		await eh.task(
			label,
			(id) => action(id, connectionId),
			(value) => {
				result = value
			},
			report,
		)
		return result
	}
	async function loadContext() {
		const value = await run('Load Event Hubs administration', (id, connectionId) =>
			eventHubsApi.getEventAdminContext({ id, connectionId }),
		)
		if (value) context.value = value
		return value
	}
	const get = (target: EventAdminTarget) =>
		run('Inspect Event Hubs resource', (id, connectionId) =>
			eventHubsApi.getEventAdminResource({ id, connectionId, target: { ...target } }),
		)
	const policies = (hubName: string, continuationToken: string | null = null) =>
		run('List Event Hubs SAS policies', (id, connectionId) =>
			eventHubsApi.listEventPolicies({ id, connectionId, hubName, continuationToken }),
		)
	const key = (
		target: EventPolicyKeyRequest['target'],
		keyType: EventPolicyKeyRequest['keyType'],
	) =>
		run('Reveal selected Event Hubs SAS key', (id, connectionId) =>
			eventHubsApi.revealEventPolicyKey({ id, connectionId, target: { ...target }, keyType }),
		)
	const copy = (
		target: EventPolicyKeyRequest['target'],
		keyType: EventPolicyKeyRequest['keyType'],
		format: 'key' | 'connectionString',
	) =>
		run('Copy selected Event Hubs credential', (id, connectionId) =>
			eventHubsApi.copyEventPolicyKey({
				id,
				connectionId,
				target: { ...target },
				keyType,
				format,
			}),
		)
	async function change(setup: Omit<EventAdminChange, 'id' | 'connectionId'>) {
		if (blocked.value) return
		reviewed.value = false
		const result = await run(
			`${setup.action} Event Hubs ${setup.target.kind}`,
			async (id, connectionId) => {
				outcome.value = undefined
				try {
					const response = await eventHubsApi.changeEventAdminResource({
						...setup,
						id,
						connectionId,
					})
					if (
						response.ok ||
						![
							'OUTCOME_UNKNOWN',
							'TIMEOUT',
							'CANCELLED',
							'BACKEND_UNAVAILABLE',
							'INVALID_REQUEST',
						].includes(response.error.code)
					)
						return response
				} catch {
					// A missing response cannot establish rejection.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						target: setup.target,
						action: setup.action,
						status: 'unknown',
						summary:
							'The final response is unavailable. Check the retained receipt and Azure state before another change. Nothing was retried.',
					},
				} satisfies DesktopResult<EventAdminOutcome>
			},
			(value) => ({
				status:
					value.status === 'confirmed'
						? 'completed'
						: value.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: `${value.summary} Receipt: ${value.operationId}`,
			}),
		)
		if (result) outcome.value = result
		if (result?.status === 'confirmed') await refresh(result)
		return result
	}
	async function refresh(value: EventAdminOutcome) {
		const target = value.target
		if (target.kind === 'hub') {
			if (eh.hubName === target.name) {
				eh.hub = undefined
				eh.partition = undefined
				eh.partitionId = ''
				eh.groups = { items: [], continuationToken: null }
				eh.result = undefined
				eh.readId = ''
				eh.clearEvent()
				if (value.action === 'delete') eh.hubName = ''
			}
			await eh.listHubs()
			if (value.action !== 'delete') {
				const details = await get(target)
				if (details?.hub) {
					const item = {
						name: target.name,
						status: details.hub.status,
						partitionCount: details.hub.partitionCount,
						userMetadata: details.hub.userMetadata,
					}
					const i = eh.hubs.items.findIndex((x) => x.name === target.name)
					if (i < 0) eh.hubs.items.push(item)
					else eh.hubs.items[i] = item
				}
			}
		} else if (target.kind === 'group' && eh.hubName === target.hubName) {
			if (value.action === 'delete' && eh.consumerGroup === target.name) {
				eh.consumerGroup = '$Default'
				eh.partition = undefined
				eh.partitionId = ''
				eh.result = undefined
				eh.readId = ''
				eh.clearEvent()
			}
			await eh.listGroups()
			if (value.action !== 'delete' && !eh.groups.items.some((x) => x.name === target.name)) {
				const details = await get(target)
				if (details)
					eh.groups.items.push({
						name: target.name,
						status: null,
						partitionCount: null,
						userMetadata: details.userMetadata,
					})
			}
		}
	}
	async function recover() {
		if (!outcome.value) return
		const operationId = outcome.value.operationId
		const value = await run('Check Event Hubs administration receipt', (id, connectionId) =>
			eventHubsApi.getEventAdminResult({ id, connectionId, operationId }),
		)
		if (value) {
			outcome.value = value
			reviewed.value = false
			if (value.status === 'confirmed') await refresh(value)
		} else if (value === null)
			eh.error =
				'No retained receipt is available. A missing receipt does not prove the change failed. Review Azure state before continuing.'
	}
	return {
		context,
		outcome,
		reviewed,
		blocked,
		loadContext,
		get,
		policies,
		key,
		copy,
		change,
		recover,
	}
})
