import { notificationHubsApi } from '@/features/notification-hubs/api'

import {
	nhNamespace,
	type NotificationHubTarget,
	type NotificationHubScope,
} from '@shared/contracts/notification-hubs/core'
import type { NotificationManagementState } from '../../model/management-state'
import type { NotificationManagementActions } from '../../model/management-actions'

export function createNotificationManagementBrowsing(
	state: Pick<
		NotificationManagementState,
		'busy' | 'hubs' | 'selected' | 'details' | 'policies' | 'lifetime'
	>,
	actions: Pick<NotificationManagementActions, 'run'>,
) {
	const { busy, hubs, selected, details, policies, lifetime } = state
	const { run } = actions
	async function list(more = false) {
		const page = hubs
		await run(
			'Browse Notification Hubs',
			(id, connectionId) =>
				notificationHubsApi.listNotificationHub({
					id,
					connectionId,
					scope: { ...nhNamespace },
					kind: 'hubs',
					continuationToken: more ? page.value.continuationToken : null,
				}),
			(v) => {
				page.value = {
					items: more
						? [
								...page.value.items,
								...v.items.filter(
									(item) =>
										!page.value.items.some(
											(old) =>
												old.target.scope.name === item.target.scope.name,
										),
								),
							]
						: v.items,
					continuationToken: v.continuationToken,
				}
			},
		)
	}
	async function listPolicies(more = false) {
		const scope = { ...selected.value }
		await run(
			'List Notification Hubs SAS policies',
			(id, connectionId) =>
				notificationHubsApi.listNotificationHub({
					id,
					connectionId,
					scope,
					kind: 'policies',
					continuationToken: more ? policies.value.continuationToken : null,
				}),
			(v) => {
				policies.value = {
					items: more
						? [
								...policies.value.items,
								...v.items.filter(
									(item) =>
										!policies.value.items.some(
											(old) =>
												old.target.policyName === item.target.policyName,
										),
								),
							]
						: v.items,
					continuationToken: v.continuationToken,
				}
			},
		)
	}
	const get = (target: NotificationHubTarget) =>
		run('Inspect Notification Hubs resource', (id, connectionId) =>
			notificationHubsApi.getNotificationHubResource({
				id,
				connectionId,
				target: { scope: { ...target.scope }, policyName: target.policyName },
			}),
		)
	async function select(scope: NotificationHubScope) {
		if (busy.value) return
		const ticket = lifetime.generation
		selected.value = { ...scope }
		details.value = undefined
		policies.value = { items: [], continuationToken: null }
		const value = await get({ scope: { ...scope }, policyName: null })
		if (ticket !== lifetime.generation) return
		if (value) {
			details.value = value
			if (scope.kind !== 'namespace') {
				const page = hubs
				const item = {
					target: { scope: { ...scope }, policyName: null },
					registrationTtl: value.settings?.registrationTtl ?? null,
					rights: null,
				}
				const index = page.value.items.findIndex(
					(row) => row.target.scope.name === scope.name,
				)
				if (index < 0) page.value.items.push(item)
				else page.value.items[index] = item
			}
			await listPolicies()
		}
	}
	async function refresh() {
		const ticket = lifetime.generation
		await list()
		if (ticket !== lifetime.generation) return
		await select(selected.value)
	}
	return { list, listPolicies, get, select, refresh }
}
