import { BrowserWindow } from 'electron'
import { APP_NAME } from '../../shared/branding'
import appIcon from '../../renderer/src/assets/msg-commander-icon.png?asset'
export function createApplicationWindow(options: {
	preload: string
	developmentUrl?: string
	operations: Map<string, AbortController>
	resetNamespaces(): Promise<void>
	closed(): void
}) {
	const { developmentUrl, operations, resetNamespaces } = options
	const window = new BrowserWindow({
		title: APP_NAME,
		icon: appIcon,
		width: 1320,
		height: 900,
		minWidth: 960,
		minHeight: 680,
		show: false,
		backgroundColor: '#fffdfa',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		webPreferences: {
			preload: options.preload,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			webviewTag: false,
		},
	})
	if (process.platform !== 'darwin') window.setMenuBarVisibility(false)
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
	window.webContents.on('will-navigate', (event) => event.preventDefault())
	window.webContents.on('will-attach-webview', (event) => event.preventDefault())
	window.webContents.on('did-start-navigation', (event) => {
		if (event.isMainFrame && !event.isSameDocument) {
			for (const controller of operations.values()) controller.abort()
			void resetNamespaces().catch(() => {})
		}
	})
	window.webContents.on('render-process-gone', () => {
		for (const controller of operations.values()) controller.abort()
		void resetNamespaces().catch(() => {})
	})
	window.on('closed', () => {
		options.closed()
		for (const controller of operations.values()) controller.abort()
		void resetNamespaces().catch(() => {})
	})
	window.once('ready-to-show', () => window?.show())
	if (developmentUrl) void window.loadURL(developmentUrl)
	else void window.loadURL('commander://app/index.html')
	return window
}
