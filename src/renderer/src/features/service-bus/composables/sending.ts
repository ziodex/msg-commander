import { serviceBusApi } from '@/features/service-bus/api'

import type { PeekPage } from '@shared/service-bus'

import type { MessageDraft, SendTarget } from '@shared/message-operations'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'
import type { createServiceBusSettlement } from './settlement'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearInspection'> &
	Pick<ReturnType<typeof createServiceBusSettlement>, 'write'>

export function createServiceBusSending(
	state: Pick<ServiceBusState, 'busy' | 'connection' | 'messages'>,
	actions: ServiceBusDependencies,
) {
	const { busy, connection, messages } = state
	const { clearInspection, task, write } = actions
	async function sendBatch(
		target: SendTarget,
		drafts: MessageDraft[],
		scheduledEnqueueTime: string | null,
	) {
		return write(
			`${scheduledEnqueueTime ? 'Schedule' : 'Send'} ${drafts.length} messages to ${target.name}`,
			(id, connectionId) =>
				serviceBusApi.sendBatch({
					id,
					connectionId,
					target: { ...target },
					drafts: JSON.parse(JSON.stringify(drafts)),
					scheduledEnqueueTime,
				}),
		)
	}
	async function listScheduled(target: SendTarget, fromSequenceNumber: string) {
		if (!connection.value || busy.value) return
		const connectionId = connection.value.connectionId
		let page: PeekPage | undefined
		await task(
			'Browse scheduled messages',
			(id) =>
				serviceBusApi.listScheduledMessages({
					id,
					connectionId,
					target: { ...target },
					fromSequenceNumber,
					maxMessages: 25,
				}),
			(value) => {
				page = value
				messages.value = undefined
				clearInspection()
			},
		)
		return page
	}
	async function cancelScheduled(
		target: SendTarget,
		sequenceNumbers: string[],
		confirmation: string,
		preserveInspection = false,
	) {
		const result = await write(
			'Cancel scheduled messages on ' + target.name,
			(id, connectionId) =>
				serviceBusApi.cancelScheduledMessages({
					id,
					connectionId,
					target: { ...target },
					sequenceNumbers,
					confirmation,
				}),
		)
		messages.value = undefined
		if (!preserveInspection) clearInspection()
		return result
	}
	async function send(target: SendTarget, draft: MessageDraft) {
		return write('Send message to ' + target.name, (id, connectionId) =>
			serviceBusApi.sendMessage({
				id,
				connectionId,
				target: { ...target },
				draft: JSON.parse(JSON.stringify(draft)),
			}),
		)
	}
	return { sendBatch, listScheduled, cancelScheduled, send }
}
