import { serviceBusApi } from '@/features/service-bus/api'

import { subQueueLabel } from '@shared/service-bus'

import type { BodyChunk, MessageSummary, PeekTarget } from '@shared/service-bus'
import { sequenceSchema } from '@shared/service-bus'

import { decodeBase64 } from '@/shared/lib/message-body'

import type { ServiceBusState } from '../model/state'

import type { createServiceBusTasks } from './tasks'
import type { createServiceBusSelection } from './selection'

type ServiceBusDependencies = Pick<ReturnType<typeof createServiceBusTasks>, 'task'> &
	Pick<ReturnType<typeof createServiceBusSelection>, 'clearInspection'>

export function createServiceBusInspection(
	state: Pick<
		ServiceBusState,
		| 'body'
		| 'bodyStart'
		| 'busy'
		| 'connection'
		| 'error'
		| 'fromSequence'
		| 'message'
		| 'messages'
		| 'nextBodyOffset'
		| 'pageSize'
		| 'peekedFrom'
		| 'selected'
		| 'selectionView'
		| 'subQueue'
	>,
	actions: ServiceBusDependencies,
) {
	const {
		body,
		bodyStart,
		busy,
		connection,
		error,
		fromSequence,
		message,
		messages,
		nextBodyOffset,
		pageSize,
		peekedFrom,
		selected,
		selectionView,
		subQueue,
	} = state
	const { task, clearInspection } = actions
	async function peek(next = false) {
		if (
			!connection.value ||
			!selected.value ||
			selected.value.target.kind === 'topic' ||
			busy.value
		)
			return
		selectionView.value = 'messages'
		const start = next ? messages.value?.nextSequenceNumber : fromSequence.value
		if (
			!start ||
			!sequenceSchema.safeParse(start).success ||
			!Number.isInteger(pageSize.value) ||
			pageSize.value < 1 ||
			pageSize.value > 25
		) {
			error.value =
				'Use a sequence from 0 to 9223372036854775807 and a page size from 1 to 25.'
			return
		}
		const connectionId = connection.value.connectionId,
			target = { ...selected.value.target } as PeekTarget
		const previousId = selected.value.target
		await task(
			subQueue.value === 'active'
				? 'Peek messages'
				: `Peek ${subQueueLabel(subQueue.value).toLowerCase()} messages`,
			(id) =>
				serviceBusApi.peekMessages({
					id,
					connectionId,
					target,
					subQueue: subQueue.value,
					fromSequenceNumber: start,
					maxMessages: pageSize.value,
				}),
			(value) => {
				if (selected.value?.target !== previousId) return
				messages.value = value
				peekedFrom.value = start
				fromSequence.value = start
				clearInspection()
			},
		)
	}
	function applyChunk(chunk: BodyChunk) {
		const bytes = decodeBase64(chunk.base64)
		if (chunk.offset !== bodyStart.value + body.value.length)
			throw new Error('Message body offset changed. Peek again.')
		const merged = new Uint8Array(body.value.length + bytes.length)
		merged.set(body.value)
		merged.set(bytes, body.value.length)
		body.value = merged
		nextBodyOffset.value = chunk.nextOffset
	}
	async function inspect(summary: MessageSummary) {
		if (!connection.value || busy.value || !summary.snapshotId) return
		clearInspection()
		const connectionId = connection.value.connectionId,
			snapshotId = summary.snapshotId
		if (
			await task(
				'Inspect message properties',
				(id) => serviceBusApi.inspectMessage({ id, connectionId, snapshotId }),
				(value) => {
					message.value = value
					nextBodyOffset.value = 0
				},
			)
		)
			await readBody(0)
	}
	async function readBody(offset = nextBodyOffset.value) {
		if (
			!connection.value ||
			!message.value?.summary.snapshotId ||
			offset === null ||
			busy.value
		)
			return
		if (body.value.length >= 256 * 1024) return
		const connectionId = connection.value.connectionId,
			snapshotId = message.value.summary.snapshotId
		await task(
			'Read message body',
			(id) =>
				serviceBusApi.readMessageBody({
					id,
					connectionId,
					snapshotId,
					offset,
					count: 65536,
				}),
			applyChunk,
		)
	}
	async function bodyWindow(offset: number) {
		if (
			busy.value ||
			!message.value ||
			!Number.isInteger(offset) ||
			offset < 0 ||
			offset >= message.value.summary.bodySize
		)
			return
		body.value = new Uint8Array()
		bodyStart.value = offset
		nextBodyOffset.value = offset
		await readBody(offset)
	}
	return { peek, applyChunk, inspect, readBody, bodyWindow }
}
