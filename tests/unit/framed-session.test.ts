import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('isolates identical request IDs, progress, output and shutdown across concurrent backend sessions', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--framed-session-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('Framed backend session isolation checks passed')
})
