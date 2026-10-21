import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns Relay generations, request-scoped prompts and partial import receipts', () => {
	expect(
		execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--relay-boundary-checks',
			],
			{ encoding: 'utf8' },
		),
	).toContain('Relay boundary checks passed')
})
