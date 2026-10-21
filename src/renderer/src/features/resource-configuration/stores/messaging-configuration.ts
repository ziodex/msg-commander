import { resourceConfigurationApi } from '@/features/resource-configuration/api'
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useWorkspace } from '../../../shared/workspace/store'
import type { ConfigurationConnection } from '../model/connection'
import type { DesktopResult } from '@shared/contracts'
import type {
	MessagingService,
	MessagingConfigPreview,
	MessagingConfigResult,
} from '@shared/contracts/resource-configuration'
type State = {
	preview?: MessagingConfigPreview
	fileName: string
	result?: MessagingConfigResult
	operationId: string
	receiptOperationId: string
	interrupted: boolean
	error: string
	notice: string
	warnings: string[]
}
const empty = (): State => ({
	fileName: '',
	operationId: '',
	receiptOperationId: '',
	interrupted: false,
	error: '',
	notice: '',
	warnings: [],
})
export const useMessagingConfiguration = defineStore('messaging-configuration', () => {
	const workspace = useWorkspace()
	const states = ref<Record<MessagingService, State>>({
		'service-bus': empty(),
		'event-hubs': empty(),
	})
	const generation = { 'service-bus': 0, 'event-hubs': 0 }
	const connections: Partial<Record<MessagingService, string>> = {}
	function syncConnection(service: MessagingService, connectionId: string | undefined) {
		if (connections[service] === connectionId) return
		connections[service] = connectionId
		generation[service]++
		states.value[service] = empty()
	}
	async function run<T>(
		service: MessagingService,
		owner: ConfigurationConnection,
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
		report?: (value: T) => { status: 'completed' | 'failed' | 'cancelled'; message: string },
	) {
		const connectionId = owner.connection?.connectionId
		syncConnection(service, connectionId)
		if (!connectionId || owner.busy) return
		const ticket = generation[service],
			store = owner
		const current = () =>
			ticket === generation[service] && owner.connection?.connectionId === connectionId
		store.busy = label
		store.error = ''
		try {
			const value = await workspace.perform(
				label,
				(id) => {
					states.value[service].operationId = id
					return action(id, connectionId)
				},
				report,
			)
			return current() ? value : undefined
		} catch (error) {
			if (current())
				store.error =
					error instanceof Error ? error.message : 'Configuration operation failed.'
		} finally {
			if (current()) store.busy = ''
		}
	}
	async function load(service: MessagingService, owner: ConfigurationConnection) {
		syncConnection(service, owner.connection?.connectionId)
		const state = states.value[service]
		if (state.interrupted || state.result?.status === 'unknown') return
		state.preview = undefined
		state.fileName = ''
		state.notice = ''
		const value = await run(
			service,
			owner,
			'Review messaging configuration',
			(id, connectionId) =>
				resourceConfigurationApi.importMessagingConfiguration({
					id,
					connectionId,
					service,
				}),
		)
		if (value && !value.cancelled && value.preview) {
			state.preview = value.preview
			state.fileName = value.fileName ?? ''
		}
	}
	async function apply(
		service: MessagingService,
		owner: ConfigurationConnection,
		entryIds: string[],
	) {
		syncConnection(service, owner.connection?.connectionId)
		const state = states.value[service]
		if (!state.preview || state.interrupted || state.result?.status === 'unknown') return
		const importId = state.preview.importId
		state.result = undefined
		const value = await run(
			service,
			owner,
			'Import messaging configuration',
			async (id, connectionId) => {
				state.receiptOperationId = id
				const response = await resourceConfigurationApi.applyMessagingConfiguration({
					id,
					connectionId,
					service,
					importId,
					entryIds,
					acknowledged: true,
				})
				if (
					!response.ok &&
					['OUTCOME_UNKNOWN', 'TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED'].includes(
						response.error.code,
					)
				) {
					state.interrupted = true
					state.preview = undefined
				}
				return response
			},
			(result) => ({
				status:
					result.status === 'completed'
						? 'completed'
						: result.status === 'cancelled'
							? 'cancelled'
							: 'failed',
				message: result.summary,
			}),
		)
		if (value) {
			state.result = value
			state.preview = undefined
			state.interrupted = false
		}
		return value
	}
	async function recover(service: MessagingService, owner: ConfigurationConnection) {
		syncConnection(service, owner.connection?.connectionId)
		const state = states.value[service],
			operationId = state.receiptOperationId
		if (!operationId) return
		const value = await run(
			service,
			owner,
			'Recover configuration import result',
			(id, connectionId) =>
				resourceConfigurationApi.getMessagingConfigurationResult({
					id,
					connectionId,
					service,
					operationId,
				}),
		)
		state.operationId = operationId
		if (value) {
			state.result = value
			state.interrupted = false
		} else
			state.notice =
				'No retained result is available. Inspect Azure state before making another change.'
	}
	function reviewed(service: MessagingService) {
		states.value[service] = empty()
	}
	return { states, run, load, apply, recover, reviewed, syncConnection }
})
