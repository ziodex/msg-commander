import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns Event Hubs generations, receipts, cleanup retries and IoT capabilities in Application', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--eventhubs-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 15000 },
	)
	expect(output).toContain('Event Hubs boundary checks passed')
})
