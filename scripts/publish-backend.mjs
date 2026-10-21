import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const targets = {
	'darwin-arm64': 'osx-arm64',
	'darwin-x64': 'osx-x64',
	'linux-x64': 'linux-x64',
	'win32-x64': 'win-x64',
}
export function publishBackend(target = `${process.platform}-${process.arch}`) {
	const rid = targets[target]
	if (!rid) throw new Error(`Unsupported target: ${target}`)
	const output = resolve('artifacts/backend', rid)
	if (dirname(output) !== resolve('artifacts/backend'))
		throw new Error('Invalid backend output directory')
	// Publish into a clean bundle so removed dependencies cannot survive an earlier build.
	rmSync(output, { recursive: true, force: true })
	mkdirSync(output, { recursive: true })
	const result = spawnSync(
		'dotnet',
		[
			'publish',
			'backend/MsgCommander.Host',
			'-c',
			'Release',
			'-r',
			rid,
			'--self-contained',
			'true',
			'-p:RestoreLockedMode=true',
			'-p:PublishSingleFile=false',
			'-p:PublishTrimmed=false',
			'-o',
			output,
			'--nologo',
		],
		{ stdio: 'inherit' },
	)
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`Backend publish failed (${result.status})`)
	writeFileSync(
		resolve(output, 'bundle.json'),
		JSON.stringify({ product: 'Msg Commander', rid, protocolVersion: 1 }, null, 2),
	)
	return { output, rid }
}
if (process.argv[1] === resolve('scripts/publish-backend.mjs')) publishBackend(process.argv[2])
