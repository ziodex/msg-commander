import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { DesktopResult } from '../../src/shared/contracts'
import { createIpcRegistrar } from '../../src/main/ipc/registrar'

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<
		string,
		(event: unknown, input?: unknown) => Promise<DesktopResult<unknown>>
	>(),
}))
vi.mock('electron', () => ({
	ipcMain: {
		handle: (
			channel: string,
			action: (event: unknown, input?: unknown) => Promise<DesktopResult<unknown>>,
		) => handlers.set(channel, action),
	},
}))
beforeEach(() => handlers.clear())

function fixture() {
	const frame = { url: 'commander://app/index.html' }
	const webContents = { mainFrame: frame }
	const window = { webContents } as unknown as BrowserWindow
	const event = { sender: webContents, senderFrame: frame }
	const pending = new Set<Promise<unknown>>()
	let installing = false
	return {
		pending,
		event,
		handle: createIpcRegistrar(
			() => window,
			undefined,
			() => installing,
			pending,
		),
		install: () => {
			installing = true
		},
	}
}

it('drains an already accepted workspace save and refuses new writes during update shutdown', async () => {
	const { pending, event, handle, install } = fixture()
	let finish!: () => void
	const write = new Promise<void>((resolve) => {
		finish = resolve
	})
	const action = vi.fn(() => write)
	handle('commander:theme', z.enum(['light', 'dark', 'system']), action)
	const saving = handlers.get('commander:theme')!(event, 'dark')
	expect(pending.size).toBe(1)
	install()
	expect(await handlers.get('commander:theme')!(event, 'light')).toMatchObject({
		ok: false,
		error: { code: 'APP_RESTARTING' },
	})
	expect(action).toHaveBeenCalledOnce()
	let drained = false
	const shutdown = Promise.allSettled([...pending]).then(() => {
		drained = true
	})
	await Promise.resolve()
	expect(drained).toBe(false)
	finish()
	await shutdown
	expect(await saving).toEqual({ ok: true, value: undefined })
	expect(pending.size).toBe(0)
})

it('excludes the initiating update check from the shutdown drain to prevent deadlock', async () => {
	const { pending, event, handle } = fixture()
	handle('commander:updates-check', z.undefined(), async () => {
		await Promise.allSettled([...pending])
		expect(pending.size).toBe(0)
	})
	expect(await handlers.get('commander:updates-check')!(event)).toEqual({
		ok: true,
		value: undefined,
	})
})
