import { notificationHubsApi } from '@/features/notification-hubs/api'

import type { CredentialChange } from '@shared/contracts/notification-hubs/credentials'

import type { DesktopResult } from '@shared/contracts'
import {
	nhNamespace,
	type NotificationHubChange,
	type NotificationHubOutcome,
} from '@shared/contracts/notification-hubs/core'
import type { NotificationManagementState } from '../../model/management-state'
import type { NotificationManagementActions } from '../../model/management-actions'

export function createNotificationManagementMutations(
	state: Pick<
		NotificationManagementState,
		'error' | 'selected' | 'outcome' | 'reviewed' | 'blocked'
	>,
	actions: Pick<NotificationManagementActions, 'run' | 'refresh'>,
) {
	const { error, selected, outcome, reviewed, blocked } = state
	const { run, refresh } = actions
	async function change(
		setup:
			| Omit<NotificationHubChange, 'id' | 'connectionId'>
			| (Omit<CredentialChange, 'id' | 'connectionId'> & { action: 'credentials' }),
	) {
		if (blocked.value) return
		reviewed.value = false
		return run(
			'Notification Hubs: ' + setup.action,
			async (id, connectionId) => {
				try {
					const response =
						setup.action === 'credentials'
							? await notificationHubsApi.changeNotificationHubCredentials({
									id,
									connectionId,
									target: { scope: { ...setup.target.scope }, policyName: null },
									expectedRevision: setup.expectedRevision,
									draft: JSON.parse(JSON.stringify(setup.draft)),
									acknowledged: true,
								})
							: await notificationHubsApi.changeNotificationHubResource({
									...setup,
									target: {
										scope: { ...setup.target.scope },
										policyName: setup.target.policyName,
									},
									settings: setup.settings
										? {
												registrationTtl: setup.settings.registrationTtl,
												tags: setup.settings.tags.map((t) => ({ ...t })),
											}
										: null,
									rights: setup.rights ? [...setup.rights] : null,
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
					// A missing response does not prove rejection.
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
				} satisfies DesktopResult<NotificationHubOutcome>
			},
			(value) => {
				outcome.value = value
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
	}
	async function recover() {
		if (!outcome.value) return
		const operation = outcome.value.operationId
		const value = await run('Check Notification Hubs receipt', (id, connectionId) =>
			notificationHubsApi.getNotificationHubResult({
				id,
				connectionId,
				operationId: operation,
			}),
		)
		if (value) {
			outcome.value = value
			reviewed.value = false
		} else if (value === null)
			error.value =
				'No retained receipt is available. Review Azure state; this does not prove the change failed.'
	}
	async function afterChange(value: NotificationHubOutcome) {
		if (value.status !== 'confirmed') return
		if (value.target.policyName === null && value.action !== 'delete')
			selected.value = { ...value.target.scope }
		if (
			value.action === 'delete' &&
			value.target.policyName === null &&
			selected.value.kind === value.target.scope.kind &&
			selected.value.name === value.target.scope.name
		)
			selected.value = { ...nhNamespace }
		await refresh()
	}
	return { change, recover, afterChange }
}
