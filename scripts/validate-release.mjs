import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version) || process.env.GITHUB_REF_NAME !== `v${version}`)
	throw new Error('Release tag must be v followed by the stable package.json version.')
if (process.env.GITHUB_REPOSITORY !== 'ziodex/msg-commander')
	throw new Error(
		'Publish releases from ziodex/msg-commander so the installed update source remains correct.',
	)

const names =
	process.platform === 'darwin'
		? [
				'MAC_CSC_LINK',
				'MAC_CSC_KEY_PASSWORD',
				'APPLE_ID',
				'APPLE_APP_SPECIFIC_PASSWORD',
				'APPLE_TEAM_ID',
			]
		: process.platform === 'win32'
			? ['WINDOWS_CSC_LINK', 'WINDOWS_CSC_KEY_PASSWORD']
			: []
const missing = names.filter((name) => !process.env[name])
if (missing.length)
	throw new Error(`Configure the required GitHub Actions secrets: ${missing.join(', ')}`)
