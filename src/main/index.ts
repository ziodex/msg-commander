import {
	app,
	BrowserWindow,
	dialog,
	nativeTheme,
	Notification,
	protocol,
	safeStorage,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createIpcRegistrar } from './ipc/registrar'
import { registerApplicationIpc } from './ipc/register'
import { createApplicationServices, type ApplicationServices } from './app/services'
import { createApplicationWindow } from './platform/application-window'
import { configureRendererProtocol } from './platform/renderer-protocol'
import { configureApplicationMenu } from './platform/application-menu'
import { Backend } from './platform/backend'
import { WorkspaceStore } from './platform/workspace-store'
import { secureStorageAvailable } from './platform/security'
import type { AppEvent } from '../shared/contracts'
import { APP_NAME } from '../shared/branding'
import { applicationIdentity } from './platform/application-identity'
import { ApplicationUpdates } from './platform/application-updates'
import appIcon from '../renderer/src/assets/msg-commander-icon.png?asset'

const testUserData = app.commandLine.getSwitchValue('user-data-dir')
const identity = applicationIdentity(app.getPath('appData'), testUserData)
// Electron captures the OS encryption service name before ready. Restore the visible name below.
app.setName(identity.storageName)
app.setPath('userData', identity.userData)
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'commander',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
	},
])
const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
let window: BrowserWindow | undefined
let backend: Backend
let workspace: WorkspaceStore
let services: ApplicationServices
let updates: ApplicationUpdates
let quitting = false,
	restarting = false,
	installingUpdate = false
const operations = new Map<string, AbortController>()
const pendingRequests = new Set<Promise<unknown>>()
const broadcast = (event: AppEvent) => {
	if (window && !window.isDestroyed()) window.webContents.send('commander:event', event)
}
const resetNamespaces = () => services.resetNamespaces()
function createWindow() {
	window = createApplicationWindow({
		preload: join(__dirname, '../preload/index.js'),
		developmentUrl,
		operations,
		resetNamespaces,
		closed: () => {
			window = undefined
		},
	})
}
async function initialize() {
	app.setName(APP_NAME)
	if (process.platform === 'win32') app.setAppUserModelId('io.msgcommander.desktop')
	app.dock?.setIcon(appIcon)
	configureRendererProtocol(resolve(__dirname, '../renderer'))
	workspace = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'), {
		available: () =>
			secureStorageAvailable(
				process.platform,
				safeStorage.isEncryptionAvailable(),
				process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
			),
		encrypt: (value) => safeStorage.encryptString(value),
		decrypt: (value) => safeStorage.decryptString(value),
	})
	await workspace.load()
	nativeTheme.themeSource = workspace.theme
	backend = app.isPackaged
		? new Backend(
				join(
					process.resourcesPath,
					'backend',
					process.platform === 'win32' ? 'MsgCommander.Host.exe' : 'MsgCommander.Host',
				),
			)
		: new Backend('dotnet', [
				join(
					app.getAppPath(),
					process.env.COMMANDER_TEST_HOST === '1'
						? 'tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'
						: 'backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll',
				),
			])
	services = createApplicationServices(backend, workspace, () => window, broadcast)
	updates = new ApplicationUpdates(autoUpdater, {
		version: app.getVersion(),
		unavailable:
			!app.isPackaged ||
			testUserData ||
			!existsSync(join(process.resourcesPath, 'app-update.yml'))
				? 'Automatic updates are available in installed release builds. Development and isolated test profiles do not contact the update service.'
				: process.platform === 'linux' && !process.env.APPIMAGE
					? 'Install and run the AppImage release to receive automatic updates.'
					: undefined,
		show: async (message, detail, buttons = ['OK']) => {
			const options = {
				title: APP_NAME,
				message,
				detail,
				buttons,
				defaultId: buttons.length - 1,
				cancelId: buttons.length - 1,
				noLink: true,
			}
			return (
				await (window && !window.isDestroyed()
					? dialog.showMessageBox(window, options)
					: dialog.showMessageBox(options))
			).response
		},
		notify: (title, body) => {
			if (!Notification.isSupported()) return
			const notification = new Notification({ title, body })
			notification.on('click', () => {
				window?.show()
				void updates.check(true)
			})
			notification.show()
		},
		canRestart: () => operations.size === 0 && !restarting && !quitting,
		prepareRestart: async () => {
			installingUpdate = true
			restarting = true
			window?.setEnabled(false)
			await Promise.allSettled([...pendingRequests])
			await services.resetNamespaces()
			await backend.stop()
			await workspace.flush()
			quitting = true
		},
		recoverRestart: () => {
			installingUpdate = false
			restarting = false
			quitting = false
			window?.setEnabled(true)
			void backend.start().catch(() => {})
			updates.start()
		},
	})
	backend.on('status', (status) => {
		if (status.state !== 'ready') services.forgetConnections()
		broadcast({ type: 'backend', status })
	})
	backend.on('event', (event) => broadcast(event))
	registerApplicationIpc(
		{
			...services,
			backend,
			workspace,
			operations,
			checkForUpdates: () => updates.check(true),
			get window() {
				return window
			},
			get restarting() {
				return restarting
			},
			set restarting(value) {
				restarting = value
			},
		},
		createIpcRegistrar(
			() => window,
			developmentUrl,
			() => installingUpdate || quitting,
			pendingRequests,
		),
	)
	configureApplicationMenu(broadcast, () => void updates.check(true))
	createWindow()
	window?.once('ready-to-show', () => updates.start())
	void backend.start().catch(() => {})
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
	app.on('second-instance', () => {
		if (window?.isMinimized()) window.restore()
		window?.focus()
	})
	app.whenReady()
		.then(initialize)
		.catch(() => {
			dialog.showErrorBox(
				'Msg Commander could not start',
				'The workspace or application files could not be loaded. Preserve workspace.json before repairing the installation.',
			)
			app.quit()
		})
	app.on('activate', () => {
		if (backend && !window) createWindow()
	})
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit()
	})
	app.on('before-quit', (event) => {
		updates?.stop()
		if (quitting || !backend) return
		event.preventDefault()
		quitting = true
		for (const controller of operations.values()) controller.abort()
		void Promise.allSettled([...pendingRequests])
			.then(() => backend.stop())
			.finally(async () => {
				await workspace.flush()
				app.quit()
			})
	})
}
