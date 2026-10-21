import type { DesktopResult } from '@shared/contracts'

export interface NotificationTaskActions {
	task<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		apply?: (value: T) => void,
		report?: (value: T) => { status: 'completed' | 'failed' | 'cancelled'; message: string },
	): Promise<T | undefined>
}
