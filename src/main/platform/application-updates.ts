import type { AppUpdater } from 'electron-updater'

export type UpdateEngine = Pick<
	AppUpdater,
	| 'autoDownload'
	| 'autoInstallOnAppQuit'
	| 'allowPrerelease'
	| 'allowDowngrade'
	| 'checkForUpdates'
	| 'downloadUpdate'
	| 'quitAndInstall'
> & {
	on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
	on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdateInteraction {
	version: string
	unavailable?: string
	show(message: string, detail: string, buttons?: string[]): Promise<number>
	notify(message: string, detail: string): void
	canRestart(): boolean
	prepareRestart(): Promise<void>
	recoverRestart(): void
}

export class ApplicationUpdates {
	private phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error' = 'idle'
	private version = ''
	private percent = 0
	private checking?: Promise<void>
	private prompting?: Promise<void>
	private startup?: ReturnType<typeof setTimeout>
	private interval?: ReturnType<typeof setInterval>
	private stopped = false

	constructor(
		private readonly engine: UpdateEngine,
		private readonly interaction: UpdateInteraction,
	) {
		engine.autoDownload = false
		engine.autoInstallOnAppQuit = false
		engine.allowPrerelease = false
		engine.allowDowngrade = false
		engine.on('download-progress', ({ percent }) => {
			this.percent = Math.max(0, Math.min(100, Math.round(percent)))
		})
		engine.on('error', () => this.failed())
	}

	start() {
		if (this.interaction.unavailable || this.startup || this.interval) return
		this.stopped = false
		this.startup = setTimeout(() => void this.check(), 15000)
		this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000)
		this.startup.unref()
		this.interval.unref()
	}

	stop() {
		this.stopped = true
		clearTimeout(this.startup)
		clearInterval(this.interval)
		this.startup = undefined
		this.interval = undefined
	}

	async check(manual = false): Promise<void> {
		if (this.stopped) return
		if (this.interaction.unavailable) {
			if (manual)
				await this.interaction.show('Updates unavailable', this.interaction.unavailable)
			return
		}
		if (this.phase === 'installing') return
		if (this.phase === 'ready') {
			if (manual) await this.promptRestart()
			return
		}
		if (this.phase !== 'downloading') {
			this.checking ??= this.findUpdate().finally(() => {
				this.checking = undefined
			})
			await this.checking
		}
		if (manual) await this.report()
	}

	private async report() {
		if (this.phase === 'ready') {
			await this.promptRestart()
			return
		}
		if (this.phase === 'installing') return
		if (this.phase === 'downloading')
			await this.interaction.show(
				'Downloading update',
				`Msg Commander ${this.version} is downloading (${this.percent}%). You can keep working. You will be asked before restarting.`,
			)
		else if (this.phase === 'error')
			await this.interaction.show(
				'Could not check for updates',
				'Check your internet connection and try again. If no release has been published yet, try again after the first release.',
			)
		else
			await this.interaction.show(
				'You’re up to date',
				`Msg Commander ${this.interaction.version} is the latest available version.`,
			)
	}

	private async findUpdate() {
		this.phase = 'checking'
		try {
			const result = await this.engine.checkForUpdates()
			if (!result) throw new Error('Update source unavailable')
			if (!result.isUpdateAvailable) {
				this.phase = 'idle'
				return
			}
			this.version = result.updateInfo.version
			this.percent = 0
			this.phase = 'downloading'
			this.interaction.notify(
				'New version available',
				`Msg Commander ${this.version} is downloading. You can keep working.`,
			)
			void this.download()
		} catch {
			this.failed()
		}
	}

	private async download() {
		try {
			await this.engine.downloadUpdate()
			this.phase = 'ready'
			if (this.stopped) return
			this.interaction.notify(
				'Update ready',
				`Msg Commander ${this.version} is ready to install. Choose Check for updates to restart when convenient.`,
			)
			await this.promptRestart()
		} catch {
			this.failed()
		}
	}

	private promptRestart(): Promise<void> {
		this.prompting ??= this.confirmRestart().finally(() => {
			this.prompting = undefined
		})
		return this.prompting
	}

	private async confirmRestart() {
		const choice = await this.interaction.show(
			'Update ready to install',
			`Restart to install Msg Commander ${this.version}. Saved connections and preferences will be kept.`,
			['Restart and install', 'Later'],
		)
		if (choice !== 0) return
		if (!this.interaction.canRestart()) {
			await this.interaction.show(
				'Finish active operations first',
				'An operation is still running. Finish or cancel it, then choose Check for updates to install the downloaded update.',
			)
			return
		}
		this.phase = 'installing'
		try {
			await this.interaction.prepareRestart()
			this.engine.quitAndInstall(false, true)
		} catch {
			this.failed()
		}
	}

	private failed() {
		if (this.phase === 'error') return
		if (this.phase === 'installing') this.interaction.recoverRestart()
		if (this.phase === 'downloading' || this.phase === 'installing')
			this.interaction.notify(
				'Update could not be installed',
				'Your saved connections are unchanged. Choose Check for updates to try again.',
			)
		this.phase = 'error'
	}
}
