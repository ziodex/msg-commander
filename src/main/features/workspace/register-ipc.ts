import { desktopPreferencesSchema, operationLogSchema } from '../../../shared/desktop-tools'

import { exportOperationLog } from './desktop-tools'

import { savePreferencesSchema } from '../../../shared/application-settings'

import { app, clipboard, dialog, nativeTheme, shell } from 'electron'

import { z } from 'zod'
import { HostError } from '../../platform/backend'

import {
	idSchema,
	operationSchema,
	profileInputSchema,
	themeSchema,
	type Bootstrap,
} from '../../../shared/contracts'

import type { MainIpcContext } from '../../ipc/context'
import type { IpcRegistrar } from '../../ipc/types'

export function registerWorkspaceIpc(
	context: Pick<
		MainIpcContext,
		| 'backend'
		| 'operations'
		| 'resetNamespaces'
		| 'restarting'
		| 'window'
		| 'workspace'
		| 'checkForUpdates'
	>,
	handle: IpcRegistrar,
) {
	handle('commander:updates-check', z.undefined(), () => context.checkForUpdates())
	handle('commander:bootstrap', z.undefined(), (): Bootstrap => ({
		version: app.getVersion(),
		platform: process.platform,
		status: context.backend.status,
		profiles: context.workspace.list(),
		theme: context.workspace.theme,
		preferenceState: context.workspace.preferenceState,
	}))
	handle('commander:interface-scale', desktopPreferencesSchema.shape.scale, (scale) => {
		context.window!.webContents.setZoomFactor(scale)
		return null
	})
	handle('commander:operation-log', operationLogSchema, (value) =>
		exportOperationLog(value, {
			copy: (text) => clipboard.writeText(text),
			save: async () => {
				const result = await dialog.showSaveDialog(context.window!, {
					title: 'Save operation log',
					defaultPath: 'Commander-operations.log',
					filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
				})
				return result.canceled ? undefined : result.filePath
			},
		}),
	)
	handle('commander:preferences', savePreferencesSchema, (value) =>
		context.workspace.savePreferences(value.preferences, value.revision),
	)
	handle('commander:save-profile', profileInputSchema, async (value) => {
		for (const controller of context.operations.values()) controller.abort()
		await context.resetNamespaces()
		return context.workspace.save(value)
	})
	handle('commander:remove-profile', idSchema, async (value) => {
		for (const controller of context.operations.values()) controller.abort()
		await context.resetNamespaces()
		return context.workspace.remove(value)
	})
	handle('commander:theme', themeSchema, async (value) => {
		await context.workspace.setTheme(value)
		nativeTheme.themeSource = value
	})
	handle('commander:login', z.undefined(), () =>
		shell.openExternal('https://microsoft.com/devicelogin'),
	)
	handle('commander:run', operationSchema, async (operation) => {
		if (context.backend.status.state !== 'ready' || context.restarting)
			throw new HostError(
				'BACKEND_UNAVAILABLE',
				'Wait for the backend or restart it to continue.',
			)
		if (context.operations.has(operation.id) || context.operations.size >= 16)
			throw new HostError('BUSY', 'Operation limit reached or ID already in use.')
		const controller = new AbortController()
		context.operations.set(operation.id, controller)
		try {
			return operation.kind === 'diagnostics'
				? await context.backend.request(
						'diagnostics.run',
						{ operationId: operation.id, durationMs: 2500 },
						{ signal: controller.signal },
					)
				: await context.backend.request(
						'auth.test',
						{
							operationId: operation.id,
							profile: context.workspace.getForBackend(operation.profileId),
						},
						{ signal: controller.signal, timeout: 300000 },
					)
		} finally {
			context.operations.delete(operation.id)
		}
	})
	handle('commander:cancel', idSchema, (id) => {
		context.operations.get(id)?.abort()
	})
	handle('commander:restart', z.undefined(), async () => {
		if (context.restarting)
			throw new HostError('BUSY', 'Backend restart is already in progress.')
		context.restarting = true
		try {
			for (const controller of context.operations.values()) controller.abort()
			await context.backend.restart()
		} finally {
			context.restarting = false
		}
	})
}
