import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves safe provider failure classification after removing SDK dependencies from Host', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--provider-failure-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('Provider failure mapping checks passed')
})
