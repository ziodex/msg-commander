import type {
	EventGridReceive,
	EventGridSettle,
	EventGridReceived,
	EventGridEventInspection,
	EventGridPullOutcome,
} from '@shared/contracts/event-grid/pulling'
import type {
	EventGridPublish,
	EventGridPublishOutcome,
} from '@shared/contracts/event-grid/publishing'
import type {
	EventGridAdminChange,
	EventGridAdminOutcome,
	EventGridAdminDetails,
} from '@shared/contracts/event-grid/administration'

import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
import { type EventGridConnect, type EventGridTarget } from '@shared/contracts/event-grid/core'

declare const workspace: ReturnType<typeof useWorkspace>
export interface EventGridActions {
	reset(): void
	task<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<T | undefined>
	connect(setup: Omit<EventGridConnect, 'id'>): Promise<void>
	disconnect(): Promise<void>
	loadTopics(more?: boolean): Promise<void>
	loadSubscriptions(topicName: string, more?: boolean): Promise<void>
	toggle(topicName: string): Promise<void>
	inspect(target: EventGridTarget): Promise<void>
	refreshInspection(): Promise<void>
	closeInspection(): void
	adminGet(target: EventGridTarget): Promise<EventGridAdminDetails | undefined>
	change(
		setup: Omit<EventGridAdminChange, 'id' | 'connectionId'>,
	): Promise<EventGridAdminOutcome | undefined>
	recover(): Promise<void>
	afterChange(value: EventGridAdminOutcome): Promise<void>
	publish(
		setup: Omit<EventGridPublish, 'id' | 'connectionId'>,
	): Promise<EventGridPublishOutcome | undefined>
	recoverPublish(): Promise<void>
	refreshReceived(
		target: EventGridTarget,
		clear?: boolean,
	): Promise<EventGridReceived[] | undefined>
	inspectEvent(
		target: EventGridTarget,
		handle: string,
	): Promise<EventGridEventInspection | undefined>
	pull(
		setup:
			| Omit<EventGridReceive, 'id' | 'connectionId'>
			| Omit<EventGridSettle, 'id' | 'connectionId'>,
	): Promise<EventGridPullOutcome | undefined>
	recoverPull(): Promise<void>
	cancel(): '' | Promise<void>
	receive(
		setup: Omit<EventGridReceive, 'id' | 'connectionId'>,
	): Promise<EventGridPullOutcome | undefined>
	settle(
		setup: Omit<EventGridSettle, 'id' | 'connectionId'>,
	): Promise<EventGridPullOutcome | undefined>
}
