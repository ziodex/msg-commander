import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns interactive snapshots, session state, settlement uncertainty and mutation receipts in Application', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--interactive-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Interactive boundary checks passed')
})
