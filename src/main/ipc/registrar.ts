import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { HostError } from '../platform/backend'
import { trustedRendererUrl } from '../platform/security'
import type { DesktopResult } from '../../shared/contracts'
import type { IpcRegistrar } from './types'
import type {
	DesktopChannel,
	DesktopRequest,
	DesktopValue,
} from '../../shared/contracts/desktop-channels'

export function createIpcRegistrar(
	getWindow: () => BrowserWindow | undefined,
	developmentUrl: string | undefined,
	installingUpdate: () => boolean = () => false,
	pendingRequests: Set<Promise<unknown>> = new Set(),
): IpcRegistrar {
	function handle<K extends DesktopChannel>(
		channel: K,
		schema: z.ZodType<DesktopRequest<K>>,
		action: (value: DesktopRequest<K>) => DesktopValue<K> | Promise<DesktopValue<K>>,
	) {
		ipcMain.handle(channel, async (event, input): Promise<DesktopResult<unknown>> => {
			const window = getWindow()
			if (
				!window ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				!trustedRendererUrl(event.senderFrame.url, developmentUrl)
			)
				return {
					ok: false,
					error: { code: 'FORBIDDEN', message: 'Untrusted application frame.' },
				}
			try {
				if (installingUpdate())
					throw new HostError(
						'APP_RESTARTING',
						'An update is being installed. Wait for the application to restart.',
					)
				const pending = Promise.resolve(action(schema.parse(input)))
				// An update check can initiate shutdown and must never wait for itself.
				if (channel !== 'commander:updates-check') pendingRequests.add(pending)
				try {
					return { ok: true, value: await pending }
				} finally {
					pendingRequests.delete(pending)
				}
			} catch (error) {
				if (error instanceof HostError)
					return { ok: false, error: { code: error.code, message: error.message } }
				return {
					ok: false,
					error: {
						code: 'INVALID_REQUEST',
						message:
							error instanceof z.ZodError
								? 'Check the required fields and try again.'
								: 'The request failed. Check connection settings or restart the backend.',
					},
				}
			}
		})
	}
	return handle
}
