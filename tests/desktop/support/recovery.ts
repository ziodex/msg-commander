import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CommanderApi, DesktopResult } from '../../../src/shared/contracts'
import { RecoveryHarness } from '../../emulator/support/recovery-harness'

type ApiMethod = {
	[K in keyof CommanderApi]: CommanderApi[K] extends (
		...args: never[]
	) => Promise<DesktopResult<unknown>>
		? K
		: never
}[keyof CommanderApi]
type ApiValue<K extends ApiMethod> =
	Awaited<ReturnType<CommanderApi[K]>> extends DesktopResult<infer T> ? T : never
export class DesktopRecovery {
	harness = new RecoveryHarness()
	app?: ElectronApplication
	page!: Page
	directory = ''
	connectionId = ''
	pid = 0
	async call<K extends ApiMethod>(
		method: K,
		input: Parameters<CommanderApi[K]>[0],
	): Promise<ApiValue<K>> {
		const response = await this.page.evaluate(
			async ({ method, input }) => {
				const invoke = window.commander[method] as (
					input: unknown,
				) => Promise<DesktopResult<unknown>>
				return invoke(input)
			},
			{ method, input },
		)
		if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
		return response.value as ApiValue<K>
	}
	async start() {
		if (!process.env.COMMANDER_PACKAGED_EXECUTABLE)
			throw new Error('Set COMMANDER_PACKAGED_EXECUTABLE to the Windows package under test.')
		await this.harness.start()
		this.directory = await mkdtemp(join(tmpdir(), 'commander-native-recovery-'))
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		this.app = await electron.launch({
			executablePath: resolve(process.env.COMMANDER_PACKAGED_EXECUTABLE!),
			args: [`--user-data-dir=${this.directory}`],
			env,
		})
		this.page = await this.app.firstWindow()
		this.pid = await this.app.evaluate(() => process.pid)
		await expect(this.page.getByText('Backend connected', { exact: true })).toBeVisible({
			timeout: 20000,
		})
		await this.call('saveProfile', this.harness.profile)
		await this.connect()
		await this.page.evaluate(() => {
			const state = window as typeof window & {
				recoveryEvents: {
					operationId: string
					sent: number
					settled: number
					phase: string
				}[]
			}
			state.recoveryEvents = []
			window.commander.onEvent((event) => {
				if (event.type === 'test-job-progress') {
					state.recoveryEvents.push(event)
					if (state.recoveryEvents.length > 32) state.recoveryEvents.shift()
				}
			})
		})
	}
	request() {
		return { id: crypto.randomUUID(), connectionId: this.connectionId }
	}
	job(changes: Parameters<RecoveryHarness['job']>[0] = {}) {
		return this.harness.job({ connectionId: this.connectionId, ...changes })
	}
	async connect() {
		this.connectionId = (
			await this.call('connectNamespace', {
				id: crypto.randomUUID(),
				profileId: this.harness.profile.id,
			})
		).connectionId
	}
	async reconnect() {
		await this.call('disconnectNamespace', this.request())
		await this.connect()
	}
	async progress(id: string) {
		return this.page.evaluate((id) => {
			const state = window as typeof window & {
				recoveryEvents: {
					operationId: string
					sent: number
					settled: number
					phase: string
				}[]
			}
			return state.recoveryEvents.filter((event) => event.operationId === id).at(-1)
		}, id)
	}
	async resources() {
		const { stdout } = await promisify(execFile)('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`$ownedIds = @(${this.pid}) + @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${this.pid}" | Select-Object -ExpandProperty ProcessId); @(Get-Process -Id $ownedIds -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid=$_.Id; name=$_.ProcessName; handles=$_.HandleCount; privateBytes=$_.PrivateMemorySize64; workingBytes=$_.WorkingSet64 } }) | ConvertTo-Json -Compress`,
		])
		const processes = JSON.parse(stdout) as {
			pid: number
			name: string
			handles: number
			privateBytes: number
			workingBytes: number
		}[]
		return {
			at: new Date().toISOString(),
			processes,
			privateBytes: processes.reduce((sum, p) => sum + p.privateBytes, 0),
			handles: processes.reduce((sum, p) => sum + p.handles, 0),
		}
	}
	async close() {
		await this.app?.close()
		await this.harness.close()
		if (this.directory) {
			const target = resolve(this.directory)
			if (
				dirname(target) !== resolve(tmpdir()) ||
				!basename(target).startsWith('commander-native-recovery-')
			)
				throw new Error('Unexpected test cleanup directory')
			await rm(target, { recursive: true, force: true })
		}
	}
}
