import { build, Platform, Arch } from 'electron-builder'
import { publishBackend, targets } from './publish-backend.mjs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const target =
	args.find((value) => !value.startsWith('--')) ?? `${process.platform}-${process.arch}`
if (!targets[target] || args.some((value) => value.startsWith('--') && value !== '--dir'))
	throw new Error(
		'Usage: npm run package -- [darwin-arm64|darwin-x64|linux-x64|win32-x64] [--dir]',
	)
const { output } = publishBackend(target)
const [os, arch] = target.split('-')
const platform = { darwin: Platform.MAC, linux: Platform.LINUX, win32: Platform.WINDOWS }[os]
await build({
	targets: platform.createTarget(
		args.includes('--dir') ? ['dir'] : undefined,
		arch === 'arm64' ? Arch.arm64 : Arch.x64,
	),
	publish: 'never',
	config: {
		...require('../electron-builder.cjs'),
		...(process.env.COMMANDER_PACKAGE_OUTPUT
			? {
					directories: {
						...require('../electron-builder.cjs').directories,
						output: resolve(process.env.COMMANDER_PACKAGE_OUTPUT),
					},
				}
			: {}),
		extraResources: [{ from: output, to: 'backend', filter: ['**/*', '!**/*.pdb'] }],
	},
})
