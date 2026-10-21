import type {
	DesktopChannel,
	DesktopArguments,
	DesktopResponse,
} from '../shared/contracts/desktop-channels'

export type PreloadInvoker = <K extends DesktopChannel>(
	channel: K,
	...args: DesktopArguments<K>
) => Promise<DesktopResponse<K>>
