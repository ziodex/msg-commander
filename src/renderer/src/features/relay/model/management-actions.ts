import { useWorkspace } from '@/shared/workspace/store'
import type { DesktopResult } from '@shared/contracts'
declare const workspace: ReturnType<typeof useWorkspace>
export interface RelayActions {
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
	reset(): void
	refresh(): Promise<void>
}
