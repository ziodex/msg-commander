import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns independent data generations and retains failed cleanup before acquiring replacements', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--nh-data-boundary-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('Notification Hubs data boundary checks passed')
})
