import type { z } from 'zod'

import type {
	DesktopChannel,
	DesktopRequest,
	DesktopValue,
} from '../../shared/contracts/desktop-channels'

// The trusted-frame and runtime schema checks remain in the registrar.
export type IpcRegistrar = <K extends DesktopChannel>(
	channel: K,
	schema: z.ZodType<DesktopRequest<K>>,
	action: (value: DesktopRequest<K>) => DesktopValue<K> | Promise<DesktopValue<K>>,
) => void
export type WithOperation = <T>(
	id: string,
	action: (signal: AbortSignal) => Promise<T>,
) => Promise<T>
