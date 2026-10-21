import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('enforces domain topology and Event Hubs limits, typed configuration receipts and management ownership', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--configuration-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Configuration boundary checks passed')
})
