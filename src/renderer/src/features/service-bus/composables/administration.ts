import { serviceBusApi } from '@/features/service-bus/api'

import type { SubscriptionTarget, RulePage, RuleConfiguration, RuleDefinition } from '@shared/rules'

import type { EntityTarget } from '@shared/service-bus'

import type { EntityConfiguration, EntitySettings } from '@shared/entity-management'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'
import type { createServiceBusNavigation } from './navigation'
import type { createServiceBusSettlement } from './settlement'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearEntity' | 'clearInspection'> &
	Pick<ReturnType<typeof createServiceBusNavigation>, 'browse' | 'select'> &
	Pick<ReturnType<typeof createServiceBusSettlement>, 'write'>

export function createServiceBusAdministration(
	state: Pick<ServiceBusState, 'busy' | 'connection' | 'messages'>,
	actions: ServiceBusDependencies,
) {
	const { busy, connection, messages } = state
	const { browse, clearEntity, clearInspection, select, task, write } = actions
	async function listRules(target: SubscriptionTarget, continuationToken: string | null = null) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let page: RulePage | undefined
		await task(
			'Load subscription rules',
			(id) =>
				serviceBusApi.listRules({
					id,
					connectionId,
					target: { ...target },
					continuationToken,
				}),
			(value) => {
				page = value
			},
		)
		return page
	}
	async function getRule(target: SubscriptionTarget, name: string) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let rule: RuleConfiguration | undefined
		await task(
			'Load rule settings',
			(id) => serviceBusApi.getRule({ id, connectionId, target: { ...target }, name }),
			(value) => {
				rule = value
			},
		)
		return rule
	}
	async function manageRule(
		action: 'create' | 'update' | 'delete',
		target: SubscriptionTarget,
		name: string,
		definition: RuleDefinition,
		expectedRevision: string,
		confirmation: string,
	) {
		return write(`${action} rule: ${name}`, (id, connectionId) => {
			const base = { id, connectionId, target: { ...target }, name }
			if (action === 'delete')
				return serviceBusApi.deleteRule({ ...base, expectedRevision, confirmation })
			const plain = JSON.parse(JSON.stringify(definition)) as RuleDefinition
			return action === 'create'
				? serviceBusApi.createRule({ ...base, definition: plain })
				: serviceBusApi.updateRule({ ...base, definition: plain, expectedRevision })
		})
	}
	async function getConfiguration(
		target: EntityTarget,
	): Promise<EntityConfiguration | undefined> {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let configuration: EntityConfiguration | undefined
		await task(
			'Load entity settings',
			(id) =>
				serviceBusApi.getEntityConfiguration({ id, connectionId, target: { ...target } }),
			(value) => {
				configuration = value
			},
		)
		return configuration
	}
	async function manageEntity(
		action: 'create' | 'update' | 'delete',
		target: EntityTarget,
		settings?: EntitySettings,
		expectedRevision?: string,
		confirmation = '',
	) {
		const connectionId = connection.value?.connectionId
		if (!connectionId || busy.value) return
		const result = await write(
			`${action} ${target.kind}: ${target.name}`,
			(id, connectionId) => {
				const base = { id, connectionId, target: { ...target } }
				if (action === 'delete')
					return serviceBusApi.deleteEntity({
						...base,
						expectedRevision: expectedRevision!,
						confirmation,
					})
				const plain = JSON.parse(JSON.stringify(settings)) as EntitySettings
				return action === 'create'
					? serviceBusApi.createEntity({ ...base, settings: plain })
					: serviceBusApi.updateEntity({
							...base,
							settings: plain,
							expectedRevision: expectedRevision!,
						})
			},
		)
		if (connection.value?.connectionId !== connectionId) return
		if (result) {
			messages.value = undefined
			clearInspection()
		}
		if (result?.status === 'confirmed') {
			// Restart pagination after mutations. Select a created/edited entity directly even if it is beyond page one.
			await browse(target.kind, target.kind === 'subscription' ? target.topicName : undefined)
			if (action !== 'delete')
				await select({
					target,
					status: settings!.status,
					requiresSession: settings!.requiresSession,
				})
		} else if (result?.status === 'unknown') {
			// The host invalidates snapshots at dispatch. Never offer an old peek handle as current after a write.
			clearEntity()
		}
		return result
	}
	return { listRules, getRule, manageRule, getConfiguration, manageEntity }
}
