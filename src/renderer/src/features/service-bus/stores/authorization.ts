import { serviceBusApi } from '@/features/service-bus/api'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { DesktopResult } from '@shared/contracts'
import type { OperationOutcome } from '@shared/message-operations'
import type {
	AuthorizationContext,
	AuthorizationSession,
	AuthorizationTarget,
	AuthorizationRight,
	AuthorizationKeyType,
} from '@shared/authorization'
import { useServiceBus } from './service-bus'
import { useWorkspace } from '../../../shared/workspace/store'

export const useAuthorization = defineStore('authorization', () => {
	const sb = useServiceBus(),
		workspace = useWorkspace()
	const session = ref<AuthorizationSession>()
	const outcome = ref<OperationOutcome>()
	const error = ref('')
	let generation = 0
	watch(
		() => sb.connection?.connectionId,
		() => {
			generation++
			session.value = undefined
			outcome.value = undefined
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
				error.value = cause instanceof Error ? cause.message : 'SAS policy request failed.'
		} finally {
			if (ticket === generation) sb.busy = ''
		}
	}
	async function connect(context: AuthorizationContext) {
		if (!sb.connection || sb.busy || outcome.value?.status === 'unknown') return
		const connectionId = sb.connection.connectionId
		session.value = undefined
		const result = await run('Sign in to Azure management', (id) =>
			serviceBusApi.connectAuthorization({ id, connectionId, context: { ...context } }),
		)
		if (result) session.value = result
		return result
	}
	function base(target: AuthorizationTarget) {
		if (!sb.connection || !session.value) return
		return {
			connectionId: sb.connection.connectionId,
			authorizationId: session.value.authorizationId,
			target: { ...target },
		}
	}
	async function list(target: AuthorizationTarget) {
		const scope = base(target)
		if (scope)
			return run('Load SAS authorization rules', (id) =>
				serviceBusApi.listAuthorizationRules({ id, ...scope }),
			)
	}
	async function get(target: AuthorizationTarget, name: string) {
		const scope = base(target)
		if (scope)
			return run('Inspect SAS authorization rule', (id) =>
				serviceBusApi.getAuthorizationRule({ id, ...scope, name }),
			)
	}
	async function key(target: AuthorizationTarget, name: string, keyType: AuthorizationKeyType) {
		const scope = base(target)
		if (scope)
			return run('Reveal selected SAS key', (id) =>
				serviceBusApi.revealAuthorizationKey({ id, ...scope, name, keyType }),
			)
	}
	async function copy(
		target: AuthorizationTarget,
		name: string,
		keyType: AuthorizationKeyType,
		format: 'key' | 'connectionString',
	) {
		const scope = base(target)
		if (scope)
			return run('Copy selected SAS credential', (id) =>
				serviceBusApi.copyAuthorizationKey({ id, ...scope, name, keyType, format }),
			)
	}
	async function change(
		action: 'create' | 'update' | 'delete' | 'regenerate',
		target: AuthorizationTarget,
		name: string,
		rights: AuthorizationRight[],
		expectedRevision: string,
		confirmation: string,
		keyType: AuthorizationKeyType,
	) {
		const scope = base(target)
		if (!scope || sb.busy || outcome.value?.status === 'unknown') return
		outcome.value = undefined
		const result = await run<OperationOutcome>(
			`${action} SAS authorization rule`,
			async (id) => {
				const request = {
					...scope,
					id,
					name,
					rights: [...rights],
					expectedRevision,
					confirmation,
					keyType,
				}
				try {
					let response: DesktopResult<OperationOutcome>
					// Send only each method's strict contract fields.
					const rule = { ...scope, id, name }
					if (action === 'create')
						response = await serviceBusApi.createAuthorizationRule({
							...rule,
							rights: request.rights,
						})
					else if (action === 'update')
						response = await serviceBusApi.updateAuthorizationRule({
							...rule,
							rights: request.rights,
							expectedRevision,
							confirmation,
						})
					else if (action === 'delete')
						response = await serviceBusApi.deleteAuthorizationRule({
							...rule,
							expectedRevision,
							confirmation,
						})
					else
						response = await serviceBusApi.regenerateAuthorizationKey({
							...rule,
							expectedRevision,
							confirmation,
							keyType,
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
					// IPC failure after dispatch cannot establish a rejected mutation.
				}
				return {
					ok: true,
					value: {
						operationId: id,
						status: 'unknown' as const,
						summary:
							'SAS rule outcome is unknown. Nothing was retried. Check the receipt and Azure before any further change.',
						messageId: null,
					},
				}
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
		return result
	}
	async function checkOutcome() {
		if (!sb.connection || !outcome.value) return
		const connectionId = sb.connection.connectionId,
			operationId = outcome.value.operationId
		const result = await run('Check SAS operation receipt', (id) =>
			serviceBusApi.getOperationOutcome({ id, connectionId, operationId }),
		)
		if (result) outcome.value = result
		else if (result === null)
			error.value =
				'No receipt is available. Verify Azure state; a missing receipt does not prove failure.'
	}
	return { session, outcome, error, connect, list, get, key, copy, change, checkOutcome }
})
