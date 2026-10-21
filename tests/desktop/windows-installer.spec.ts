import { test, expect } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFile, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { promisify } from 'node:util'
import { access, mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { emulatorProfile } from '../emulator/support/recovery-harness'

test.skip(
	process.platform !== 'win32' || process.env.COMMANDER_INSTALLER !== '1',
	'Explicit Windows installer opt-in and an unused product installation required.',
)

const execute = promisify(execFile)
const powershell = (script: string) =>
	execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])

async function inventory() {
	const { stdout } = await powershell(`
    $roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')
    $entries=@(foreach($root in $roots){ Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object DisplayName -Match '^(?:Msg Commander|Service Bus Commander)(?:$| [0-9])' | ForEach-Object { [pscustomobject]@{version=$_.DisplayVersion;uninstall=$_.UninstallString;key=$_.PSPath} } })
    $shell=New-Object -ComObject WScript.Shell
    $links=@(foreach($folder in @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('Programs'))){foreach($name in @('Msg Commander.lnk','Service Bus Commander.lnk')){$file=Join-Path $folder $name;if(Test-Path -LiteralPath $file){[pscustomobject]@{path=$file;target=$shell.CreateShortcut($file).TargetPath}}}})
    [pscustomobject]@{entries=$entries;links=$links} | ConvertTo-Json -Depth 5 -Compress
  `)
	return JSON.parse(stdout) as {
		entries: { version: string; uninstall: string; key: string }[]
		links: { path: string; target: string }[]
	}
}
async function fingerprint(file: string) {
	try {
		return createHash('sha256')
			.update(await readFile(file))
			.digest('hex')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}
async function exists(file: string) {
	try {
		await access(file)
		return true
	} catch {
		return false
	}
}

test('installs, upgrades protected settings and credentials, then uninstalls without data loss', async () => {
	const recovery = process.env.COMMANDER_INSTALLER_RECOVERY === '1'
	test.setTimeout(recovery ? 360000 : 240000)
	const previous = resolve(process.env.COMMANDER_PREVIOUS_INSTALLER!)
	const candidate = resolve(process.env.COMMANDER_CANDIDATE_INSTALLER!)
	const previousVersion = process.env.COMMANDER_PREVIOUS_VERSION ?? '0.61.0'
	const candidateVersion = JSON.parse(await readFile('package.json', 'utf8')).version as string
	const previousParts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(previousVersion)
	if (!previousParts) throw new Error('Set the previous installer version explicitly')
	const legacyPrevious =
		Number(previousParts[1]) === 0 &&
		(Number(previousParts[2]) < 62 ||
			(Number(previousParts[2]) === 62 && Number(previousParts[3]) < 1))
	if (recovery && legacyPrevious)
		throw new Error(
			'Installer recovery requires a previous installer with scoped process checks (0.62.1 or later).',
		)
	await access(previous)
	await access(candidate)
	const before = await inventory()
	expect(before.entries, 'A real installation must never be replaced by this test').toEqual([])
	expect(before.links, 'Existing user shortcuts must never be replaced by this test').toEqual([])
	const { stdout: running } = await powershell(
		"$ErrorActionPreference=\"Stop\"; @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @('msg-commander.exe','service-bus-commander.exe') }).Count",
	)
	if (legacyPrevious)
		expect(
			Number(running.trim()),
			'The older test installer must run without other app copies',
		).toBe(0)
	expect((await fetch('http://127.0.0.1:5300/health')).ok).toBe(true)
	const root = await mkdtemp(resolve('artifacts/windows-installer-'))
	const install = join(root, 'App With Spaces')
	const profile = join(root, 'isolated-profile')
	const executable = join(install, 'msg-commander.exe')
	const previousExecutableName = (await exists(
		join(dirname(previous), 'win-unpacked', 'msg-commander.exe'),
	))
		? 'msg-commander.exe'
		: 'service-bus-commander.exe'
	const previousBackendName =
		previousExecutableName === 'msg-commander.exe'
			? 'MsgCommander.Host.dll'
			: 'ServiceBusCommander.Host.dll'
	const untouched = ['Msg Commander', 'Service Bus Commander'].map((name) =>
		join(process.env.APPDATA!, name, 'workspace.json'),
	)
	const userWorkspaceBefore = await Promise.all(untouched.map(fingerprint))
	const observations: Record<string, unknown> = { previous, candidate, root, before }
	let app: ElectronApplication | undefined,
		canary: ElectronApplication | undefined,
		page: Page,
		installed = false
	async function launchCanary() {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		canary = await electron.launch({
			executablePath: join(dirname(candidate), 'win-unpacked', 'msg-commander.exe'),
			args: [`--user-data-dir=${join(root, 'portable-canary')}`],
			env,
		})
		await expect(
			(await canary.firstWindow()).getByText('Backend connected', { exact: true }),
		).toBeVisible({ timeout: 20000 })
	}
	function guard() {
		if (
			dirname(root) !== resolve('artifacts') ||
			!basename(root).startsWith('windows-installer-') ||
			dirname(install) !== root ||
			basename(install) !== 'App With Spaces'
		)
			throw new Error('Unexpected Windows installer test directory')
	}
	async function runInstaller(file: string) {
		guard()
		const registered = await inventory()
		if (registered.entries.length) {
			expect(registered.entries).toHaveLength(1)
			const registeredPath = /^"([^"]+)"/.exec(registered.entries[0]!.uninstall)?.[1]
			if (
				!registeredPath ||
				dirname(resolve(registeredPath)).toLowerCase() !== install.toLowerCase()
			)
				throw new Error('Product registration no longer belongs to this test installation')
		}
		// NSIS requires /D to be last and unquoted, including when the directory contains spaces.
		await execute(file, ['/S', `/D=${install}`], {
			windowsVerbatimArguments: true,
			timeout: 90000,
		})
		installed = true
		const expectedExecutable = join(
			install,
			file === candidate ? 'msg-commander.exe' : previousExecutableName,
		)
		await expect.poll(() => exists(expectedExecutable), { timeout: 30000 }).toBe(true)
	}
	async function launch(version: string) {
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] =>
					!['ELECTRON_RUN_AS_NODE', 'COMMANDER_TEST_HOST'].includes(entry[0]) &&
					entry[1] !== undefined,
			),
		)
		const launchedExecutable = join(
			install,
			version === candidateVersion ? 'msg-commander.exe' : previousExecutableName,
		)
		app = await electron.launch({
			executablePath: launchedExecutable,
			args: [`--user-data-dir=${profile}`],
			env,
		})
		page = await app.firstWindow()
		await expect(page.getByText('Backend connected', { exact: true })).toBeVisible({
			timeout: 20000,
		})
		expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version)
		expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(profile)
		const bundle = join(
			dirname(version === candidateVersion ? candidate : previous),
			'win-unpacked',
		)
		const identities: Record<string, string> = {}
		const backendName =
			version === candidateVersion ? 'MsgCommander.Host.dll' : previousBackendName
		for (const file of ['resources/app.asar', `resources/backend/${backendName}`]) {
			const expected = await fingerprint(join(bundle, file))
			const actual = await fingerprint(join(install, file))
			expect(expected, `Expected packaged file: ${file}`).not.toBeNull()
			expect(actual, `Installed ${file} must match the tested package`).toBe(expected)
			identities[file] = actual!
		}
		observations.artifactIdentities = {
			...(observations.artifactIdentities as Record<string, unknown> | undefined),
			[version]: identities,
		}
		const state = await inventory()
		expect(state.entries).toHaveLength(1)
		expect(state.entries[0]!.version).toBe(version)
		expect(state.links.length).toBeGreaterThan(0)
		for (const link of state.links)
			expect(resolve(link.target).toLowerCase()).toBe(launchedExecutable.toLowerCase())
		observations[version] = state
	}
	async function uninstall() {
		guard()
		const state = await inventory()
		expect(state.entries).toHaveLength(1)
		const file = /^"([^"]+)"/.exec(state.entries[0]!.uninstall)?.[1]
		if (!file || dirname(resolve(file)).toLowerCase() !== install.toLowerCase())
			throw new Error('Uninstaller is outside the test installation')
		await execute(file, ['/S', '/KEEP_APP_DATA'], { timeout: 90000 })
		await expect
			.poll(async () => (await inventory()).entries.length, { timeout: 30000 })
			.toBe(0)
		await expect.poll(() => exists(executable), { timeout: 30000 }).toBe(false)
		expect((await inventory()).links).toEqual([])
		installed = false
	}
	async function verifyRetained() {
		const state = await page!.evaluate(() => window.commander.bootstrap())
		expect(state.ok).toBe(true)
		if (!state.ok) throw new Error('Unable to read retained settings')
		expect(state.value.theme).toBe('dark')
		expect(state.value.preferenceState.preferences).toMatchObject({
			peekCount: 7,
			messageSubject: 'Installer check',
		})
		expect(
			state.value.profiles.some(
				(item) =>
					item.name === 'Installer credential check' && item.secretState === 'protected',
			),
		).toBe(true)
		const profileId = state.value.profiles.find(
			(item) => item.name === 'Installer credential check',
		)!.id
		const connection = await page!.evaluate(
			(request) => window.commander.connectNamespace(request),
			{ id: randomUUID(), profileId },
		)
		expect(connection.ok, 'Retained credentials must decrypt after rollback/repair').toBe(true)
		if (!connection.ok) throw new Error('Retained credential did not reconnect')
		const entities = await page!.evaluate((request) => window.commander.listEntities(request), {
			id: randomUUID(),
			connectionId: connection.value.connectionId,
			kind: 'queue' as const,
		})
		expect(entities.ok).toBe(true)
		if (!entities.ok) throw new Error('Retained connection did not browse')
		expect(entities.value.items.some((item) => item.target.name === 'desktop-messages')).toBe(
			true,
		)
	}
	async function interruptUpgrade() {
		guard()
		const archive = join(install, 'resources', 'app.asar')
		const expectedBytes = (
			await stat(join(dirname(candidate), 'win-unpacked', 'resources', 'app.asar'))
		).size
		const beforeArchive = await fingerprint(archive)
		const starting = Date.now()
		const installer = spawn(candidate, ['/S', `/D=${install}`], {
			windowsVerbatimArguments: true,
			windowsHide: true,
			stdio: 'ignore',
		})
		let intercepted = false,
			bytesAtInterception: number | null = null
		let inspection: Promise<void> | undefined
		const watcher = watch(root, { recursive: true }, (_event, file) => {
			if (intercepted || !file || resolve(root, file).toLowerCase() !== archive.toLowerCase())
				return
			// An old archive's removal is not evidence of extraction. Require the newly created file.
			inspection = (async () => {
				try {
					const current = await stat(archive)
					if (intercepted || current.birthtimeMs < starting) return
					intercepted = true
					bytesAtInterception = current.size
					installer.kill('SIGKILL')
				} catch {
					// The old file may disappear before the replacement is created.
				}
			})()
		})
		try {
			await new Promise<void>((resolveExit, reject) => {
				const timer = setTimeout(() => {
					installer.kill('SIGKILL')
					reject(new Error('No bounded installer exit during interruption check'))
				}, 60000)
				installer.once('error', (error) => {
					clearTimeout(timer)
					reject(error)
				})
				installer.once('exit', () => {
					clearTimeout(timer)
					resolveExit()
				})
			})
			await inspection
		} finally {
			watcher.close()
		}
		const afterArchive = await fingerprint(archive)
		const registered = await inventory()
		observations.interruption = {
			installerPid: installer.pid,
			intercepted,
			bytesAtInterception,
			expectedBytes,
			beforeArchive,
			afterArchive,
			registered,
			signal: installer.signalCode,
			elapsedMs: Date.now() - starting,
		}
		expect(intercepted, 'Setup must be interrupted during actual replacement extraction').toBe(
			true,
		)
		expect(installer.signalCode).toBe('SIGKILL')
		expect(afterArchive).not.toBe(beforeArchive)
		// Prove partial installation rather than merely killing a completed setup process.
		expect(bytesAtInterception! < expectedBytes || registered.entries.length === 0).toBe(true)
	}
	try {
		await runInstaller(previous)
		await launch(previousVersion)
		const saved = {
			...emulatorProfile(),
			name: 'Installer credential check',
			rememberSecret: true,
		}
		const results = await page!.evaluate(async (input) => {
			const saved = await window.commander.saveProfile(input)
			const theme = await window.commander.setTheme('dark')
			const current = await window.commander.bootstrap()
			if (!current.ok) throw new Error('Unable to read installed settings')
			const preferences = await window.commander.savePreferences({
				revision: current.value.preferenceState.revision,
				preferences: {
					...current.value.preferenceState.preferences,
					peekCount: 7,
					messageSubject: 'Installer check',
				},
			})
			return { saved, theme, preferences }
		}, saved)
		expect(results.saved.ok).toBe(true)
		expect(results.theme.ok).toBe(true)
		expect(results.preferences.ok).toBe(true)
		if (!results.saved.ok) throw new Error('Credential save failed')
		expect(results.saved.value.find((item) => item.id === saved.id)?.secretState).toBe(
			'protected',
		)
		const workspaceFile = join(profile, 'workspace.json')
		expect(await readFile(workspaceFile, 'utf8')).not.toContain('SAS_KEY_VALUE')
		await app!.close()
		app = undefined

		await launchCanary()
		if (legacyPrevious) {
			await expect(runInstaller(candidate)).rejects.toThrow()
			expect((await inventory()).entries[0]!.version).toBe(previousVersion)
			expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
			observations.legacyUpgradeGuard =
				'Refused an unsafe older-uninstaller upgrade while another portable copy was running; that copy stayed alive'
		}
		await canary!.close()
		canary = undefined
		await runInstaller(candidate)
		await launch(candidateVersion)
		await expect(runInstaller(candidate)).rejects.toThrow()
		expect(await app!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
		const state = await page!.evaluate(() => window.commander.bootstrap())
		expect(state.ok).toBe(true)
		if (!state.ok) throw new Error('Unable to read upgraded settings')
		expect(state.value.theme).toBe('dark')
		expect(state.value.preferenceState.preferences).toMatchObject({
			peekCount: 7,
			messageSubject: 'Installer check',
		})
		expect(state.value.profiles.find((item) => item.id === saved.id)?.secretState).toBe(
			'protected',
		)
		const connection = await page!.evaluate(
			(request) => window.commander.connectNamespace(request),
			{ id: randomUUID(), profileId: saved.id },
		)
		expect(
			connection.ok,
			'The preserved OS-protected credential must decrypt and connect',
		).toBe(true)
		if (!connection.ok) throw new Error('Unable to connect with preserved credential')
		const entities = await page!.evaluate((request) => window.commander.listEntities(request), {
			id: randomUUID(),
			connectionId: connection.value.connectionId,
			kind: 'queue' as const,
		})
		expect(entities.ok).toBe(true)
		if (!entities.ok) throw new Error('Unable to browse with preserved credential')
		expect(entities.value.items.some((item) => item.target.name === 'desktop-messages')).toBe(
			true,
		)
		await page!.screenshot({ path: 'artifacts/beta-recovery/installed-workspace.png' })
		await app!.close()
		app = undefined
		if (recovery) {
			const beforeRecovery = await fingerprint(workspaceFile)
			await launchCanary()
			await runInstaller(previous)
			expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
			await launch(previousVersion)
			await verifyRetained()
			await app!.close()
			app = undefined
			await interruptUpgrade()
			expect(await fingerprint(workspaceFile)).toBe(beforeRecovery)
			expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
			await runInstaller(candidate)
			await launch(candidateVersion)
			await verifyRetained()
			await app!.close()
			app = undefined
			expect(await fingerprint(workspaceFile)).toBe(beforeRecovery)
			expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
			await canary!.close()
			canary = undefined
			observations.recovery = {
				rolledBack: previousVersion,
				repaired: candidateVersion,
				settingsPreserved: true,
				protectedCredentialReused: true,
				unrelatedPortableCopyPreserved: true,
			}
		}
		const preserved = await fingerprint(workspaceFile)
		await launchCanary()
		await uninstall()
		expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
		await runInstaller(candidate)
		expect((await inventory()).entries[0]!.version).toBe(candidateVersion)
		expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
		await uninstall()
		expect(await canary!.evaluate(({ app }) => app.getVersion())).toBe(candidateVersion)
		await canary!.close()
		canary = undefined
		expect(await fingerprint(workspaceFile)).toBe(preserved)
		expect(await Promise.all(untouched.map(fingerprint))).toEqual(userWorkspaceBefore)
		observations.passed = {
			installed: previousVersion,
			upgraded: candidateVersion,
			protectedCredentialReused: true,
			settingsPreserved: true,
			uninstalled: true,
			testProfilePreserved: true,
			userWorkspaceUnchanged: true,
			unrelatedPortableCopyPreserved: true,
			activeInstalledCopyProtected: true,
			freshInstallAlongsidePortableCopy: true,
		}
	} finally {
		await app?.close()
		await canary?.close()
		try {
			if (installed) {
				// An interrupted setup may have removed registration. Repair only this guarded folder
				// before normal uninstall; never leave the partial test as a registered user product.
				if (
					recovery &&
					(!(await exists(executable)) || (await inventory()).entries.length === 0)
				)
					await runInstaller(candidate)
				await uninstall()
			}
		} finally {
			await mkdir('artifacts/beta-recovery', { recursive: true })
			await writeFile(
				`artifacts/beta-recovery/installer-lifecycle-${previousVersion}-to-${candidateVersion}${recovery ? '-recovery' : ''}-${basename(root)}.json`,
				JSON.stringify(observations, null, 2),
			)
		}
	}
})
