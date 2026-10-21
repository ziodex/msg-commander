import type {
	NotificationHubConfigResult,
	NotificationHubConfigImportResult,
} from '@shared/contracts/notification-hubs/configuration'
import type { CredentialChange } from '@shared/contracts/notification-hubs/credentials'

import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
import {
	type NotificationHubConnect,
	type NotificationHubTarget,
	type NotificationHubDetails,
	type NotificationHubScope,
	type NotificationHubChange,
	type NotificationHubOutcome,
} from '@shared/contracts/notification-hubs/core'

declare const workspace: ReturnType<typeof useWorkspace>
export interface NotificationManagementActions {
	reset(): void
	task<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<T | undefined>
	run<T>(
		label: string,
		action: (id: string, connectionId: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: Parameters<typeof workspace.perform<T>>[2],
	): Promise<T | undefined>
	connect(setup: Omit<NotificationHubConnect, 'id'>): Promise<void>
	disconnect(): Promise<void>
	list(more?: boolean): Promise<void>
	listPolicies(more?: boolean): Promise<void>
	select(scope: NotificationHubScope): Promise<void>
	refresh(): Promise<void>
	change(
		setup:
			| Omit<NotificationHubChange, 'id' | 'connectionId'>
			| (Omit<CredentialChange, 'id' | 'connectionId'> & { action: 'credentials' }),
	): Promise<NotificationHubOutcome | undefined>
	recover(): Promise<void>
	afterChange(value: NotificationHubOutcome): Promise<void>
	importConfiguration(): Promise<NotificationHubConfigImportResult | undefined>
	applyConfiguration(entryIds: string[]): Promise<NotificationHubConfigResult | undefined>
	recoverConfiguration(): Promise<void>
	get(target: NotificationHubTarget): Promise<NotificationHubDetails | undefined>
	cancel(): '' | Promise<void>
}
