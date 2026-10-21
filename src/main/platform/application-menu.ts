import { Menu } from 'electron'
import type { AppEvent } from '../../shared/contracts'
export function configureApplicationMenu(
	broadcast: (event: AppEvent) => void,
	checkForUpdates: () => void,
) {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
			{
				label: 'File',
				submenu: [
					{
						label: 'New connection',
						accelerator: 'CmdOrCtrl+N',
						click: () => broadcast({ type: 'command', command: 'new-connection' }),
					},
					{
						label: 'Command palette',
						accelerator: 'CmdOrCtrl+K',
						click: () => broadcast({ type: 'command', command: 'palette' }),
					},
					{ type: 'separator' },
					{ role: process.platform === 'darwin' ? 'close' : 'quit' },
				],
			},
			{ role: 'editMenu' },
			{ role: 'viewMenu' },
			{ role: 'windowMenu' },
			{ label: 'Help', submenu: [{ label: 'Check for updates…', click: checkForUpdates }] },
		]),
	)
}
