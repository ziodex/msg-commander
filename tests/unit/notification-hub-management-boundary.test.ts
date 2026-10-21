import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns management generations, explicit credential access, private imports and shared write receipts', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--nh-management-boundary-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('Notification Hubs management boundary checks passed')
})
