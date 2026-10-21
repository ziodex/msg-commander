import { relayApi } from '@/features/relay/api'
import { relayNamespace, type RelayScope, type RelayTarget } from '@shared/contracts/relay/core'
import type { RelayActions } from '../../model/management-actions'
import type { RelayState } from '../../model/management-state'
export function createRelayBrowsing(
	state: Pick<
		RelayState,
		'busy' | 'hybrid' | 'wcf' | 'selected' | 'details' | 'policies' | 'lifetime'
	>,
	actions: Pick<RelayActions, 'run'>,
) {
	const { busy, hybrid, wcf, selected, details, policies, lifetime } = state
	const { run } = actions
	async function list(kind: 'hybrid' | 'wcf', more = false) {
		const page = kind === 'hybrid' ? hybrid : wcf
		await run(
			'Browse Relay resources',
			(id, connectionId) =>
				relayApi.listRelay({
					id,
					connectionId,
					scope: { ...relayNamespace },
					kind,
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
			'List Relay SAS policies',
			(id, connectionId) =>
				relayApi.listRelay({
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
	const get = (target: RelayTarget) =>
		run('Inspect Relay resource', (id, connectionId) =>
			relayApi.getRelayResource({
				id,
				connectionId,
				target: { scope: { ...target.scope }, policyName: target.policyName },
			}),
		)
	async function select(scope: RelayScope) {
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
				const page = scope.kind === 'hybrid' ? hybrid : wcf
				const count = value.properties.find((p) => p.name === 'listenerCount')?.value
				const item = {
					target: { scope: { ...scope }, policyName: null },
					listenerCount: count != null && /^\d+$/.test(count) ? Number(count) : null,
					requiresClientAuthorization:
						value.settings?.requiresClientAuthorization ?? null,
					relayType: value.settings?.relayType ?? null,
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
		await list('hybrid')
		if (ticket !== lifetime.generation) return
		await list('wcf')
		if (ticket !== lifetime.generation) return
		await select(selected.value)
	}
	return { list, listPolicies, get, select, refresh }
}
