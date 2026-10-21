import type { EventHubSend } from '@shared/contracts/event-hubs/sending'
import { useWorkspace } from '@/shared/workspace/store'

import type {
	EventHubsConnect,
	EventHubUrlTarget,
	EventHubRead,
	EventSummary,
} from '@shared/contracts/event-hubs/core'

declare const workspace: ReturnType<typeof useWorkspace>
export interface EventHubsActions {
	clearSend(): void
	rememberTab(): void
	persistTabs(): void
	activateTab(id: string): Promise<void>
	closeTab(id: string): Promise<void>
	openTab(name: string, id?: string, group?: string): boolean
	reset(): void
	clearEvent(): void
	task<T>(
		label: string,
		action: Parameters<typeof workspace.perform<T>>[1],
		apply: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<boolean>
	connect(setup: Omit<EventHubsConnect, 'id'>, iot?: boolean): Promise<void>
	disconnect(): Promise<void>
	listHubs(more?: boolean): Promise<void>
	listGroups(more?: boolean): Promise<void>
	selectHub(name: string): Promise<void>
	selectPartition(value: string, group?: string): Promise<void>
	read(
		setup: Omit<
			EventHubRead,
			'id' | 'connectionId' | 'hubName' | 'partitionId' | 'consumerGroup'
		>,
	): Promise<void>
	recoverRead(): Promise<void>
	inspect(summary: EventSummary): Promise<void>
	readBody(offset: number): Promise<void>
	send(setup: Omit<EventHubSend, 'id' | 'connectionId'>): Promise<void>
	recoverSend(): Promise<void>
	refreshStatistics(name: string): Promise<void>
	copyUrl(target: EventHubUrlTarget, scheme?: 'https' | 'sb'): Promise<void>
	cancel(): Promise<void>
}
