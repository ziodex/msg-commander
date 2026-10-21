import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves destructive receipts, immutable reviews and independent recovery acknowledgements through Application ports', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--maintenance-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Maintenance boundary checks passed')
})
