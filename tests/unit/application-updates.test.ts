import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
	ApplicationUpdates,
	type UpdateEngine,
	type UpdateInteraction,
} from '../../src/main/platform/application-updates'

const info = {
	version: '0.64.0',
	files: [],
	path: '',
	sha512: '',
	releaseDate: '2026-10-21T00:00:00Z',
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
function fixture(unavailable?: string) {
	const download = deferred<string[]>()
	const engine = Object.assign(new EventEmitter(), {
		autoDownload: true,
		autoInstallOnAppQuit: true,
		allowPrerelease: true,
		allowDowngrade: true,
		checkForUpdates: vi.fn(async () => ({
			isUpdateAvailable: true,
			updateInfo: info,
			versionInfo: info,
		})),
		downloadUpdate: vi.fn(() => download.promise),
		quitAndInstall: vi.fn(),
	}) satisfies UpdateEngine
	const interaction = {
		version: '0.63.0',
		unavailable,
		show: vi.fn(async (_message: string, _detail: string, _buttons?: string[]) => 1),
		notify: vi.fn(),
		canRestart: vi.fn(() => true),
		prepareRestart: vi.fn(async () => {}),
		recoverRestart: vi.fn(),
	} satisfies UpdateInteraction
	return { engine, interaction, download, updates: new ApplicationUpdates(engine, interaction) }
}
afterEach(() => vi.useRealTimers())

it('checks after startup and every six hours, then stops its timers', async () => {
	vi.useFakeTimers()
	const { engine, updates } = fixture()
	engine.checkForUpdates.mockResolvedValue({
		isUpdateAvailable: false,
		updateInfo: info,
		versionInfo: info,
	})
	updates.start()
	updates.start()
	await vi.advanceTimersByTimeAsync(14999)
	expect(engine.checkForUpdates).not.toHaveBeenCalled()
	await vi.advanceTimersByTimeAsync(1)
	expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
	await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
	expect(engine.checkForUpdates).toHaveBeenCalledTimes(2)
	updates.stop()
	await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
	expect(engine.checkForUpdates).toHaveBeenCalledTimes(2)
})

it('never contacts the release service from development or isolated profiles', async () => {
	const { engine, interaction, updates } = fixture('Use an installed release.')
	updates.start()
	await updates.check()
	expect(interaction.show).not.toHaveBeenCalled()
	await updates.check(true)
	expect(interaction.show).toHaveBeenCalledWith(
		'Updates unavailable',
		'Use an installed release.',
	)
	expect(engine.checkForUpdates).not.toHaveBeenCalled()
})

it('deduplicates checks and downloads and never installs on normal quit', async () => {
	const { engine, interaction, updates } = fixture()
	await Promise.all([updates.check(), updates.check()])
	expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
	expect(engine.downloadUpdate).toHaveBeenCalledTimes(1)
	expect(engine.autoInstallOnAppQuit).toBe(false)
	expect(engine.allowDowngrade).toBe(false)
	expect(engine.allowPrerelease).toBe(false)
	expect(interaction.notify).toHaveBeenCalledWith(
		'New version available',
		expect.stringContaining('0.64.0'),
	)
	engine.emit('download-progress', { percent: 42.4 })
	await updates.check(true)
	expect(interaction.show).toHaveBeenCalledWith(
		'Downloading update',
		expect.stringContaining('42%'),
	)
	expect(engine.quitAndInstall).not.toHaveBeenCalled()
})

it('notifies when ready, honors Later and waits for workspace shutdown before installing', async () => {
	const { engine, interaction, download, updates } = fixture()
	await updates.check()
	download.resolve(['verified-installer'])
	await vi.waitFor(() =>
		expect(interaction.show).toHaveBeenCalledWith(
			'Update ready to install',
			expect.stringContaining('connections'),
			['Restart and install', 'Later'],
		),
	)
	expect(engine.quitAndInstall).not.toHaveBeenCalled()
	const shutdown = deferred<void>()
	interaction.prepareRestart.mockImplementation(() => shutdown.promise)
	interaction.show.mockResolvedValue(0)
	const checking = updates.check(true)
	await vi.waitFor(() => expect(interaction.prepareRestart).toHaveBeenCalledOnce())
	expect(engine.quitAndInstall).not.toHaveBeenCalled()
	shutdown.resolve()
	await checking
	expect(engine.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true)
})

it('refuses restart while operations are running and allows a later retry', async () => {
	const { engine, interaction, download, updates } = fixture()
	interaction.canRestart.mockReturnValue(false)
	interaction.show.mockResolvedValue(0)
	await updates.check()
	download.resolve([])
	await vi.waitFor(() =>
		expect(interaction.show).toHaveBeenCalledWith(
			'Finish active operations first',
			expect.any(String),
		),
	)
	expect(interaction.prepareRestart).not.toHaveBeenCalled()
	interaction.canRestart.mockReturnValue(true)
	await updates.check(true)
	expect(engine.quitAndInstall).toHaveBeenCalledOnce()
})

it('reports an up-to-date manual check and keeps background checks quiet', async () => {
	const { engine, interaction, updates } = fixture()
	engine.checkForUpdates.mockResolvedValue({
		isUpdateAvailable: false,
		updateInfo: info,
		versionInfo: info,
	})
	await updates.check()
	expect(interaction.show).not.toHaveBeenCalled()
	await updates.check(true)
	expect(interaction.show).toHaveBeenCalledWith(
		'You’re up to date',
		expect.stringContaining('0.63.0'),
	)
	expect(engine.downloadUpdate).not.toHaveBeenCalled()
})

it('handles offline checks and failed downloads without leaking raw errors or exiting', async () => {
	const { engine, interaction, updates, download } = fixture()
	engine.checkForUpdates.mockRejectedValueOnce(new Error('private proxy details'))
	await updates.check(true)
	expect(interaction.show).toHaveBeenCalledWith(
		'Could not check for updates',
		expect.not.stringContaining('private'),
	)
	await updates.check()
	download.reject(new Error('checksum mismatch'))
	await vi.waitFor(() =>
		expect(interaction.notify).toHaveBeenCalledWith(
			'Update could not be installed',
			expect.stringContaining('unchanged'),
		),
	)
	expect(engine.quitAndInstall).not.toHaveBeenCalled()
})

it('restores the application if installer verification fails after shutdown', async () => {
	const { engine, interaction, updates, download } = fixture()
	interaction.show.mockResolvedValue(0)
	engine.quitAndInstall.mockImplementation(() => {
		engine.emit('error', new Error('Invalid signature'))
	})
	await updates.check()
	download.resolve([])
	await vi.waitFor(() => expect(interaction.recoverRestart).toHaveBeenCalledOnce())
})

it('does not open an update prompt when a pending download completes during shutdown', async () => {
	const { updates, download, interaction } = fixture()
	await updates.check()
	updates.stop()
	download.resolve([])
	await Promise.resolve()
	expect(interaction.show).not.toHaveBeenCalled()
})
