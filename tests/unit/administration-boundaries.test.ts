import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('enforces entity and policy invariants, typed administration plans and retained receipts across the project boundary', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--administration-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Administration boundary checks passed')
})
