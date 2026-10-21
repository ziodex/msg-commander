import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns Event Grid generations, opaque leases, bounded receipts and explicit cleanup in Application', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--eventgrid-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 15000 },
	)
	expect(output).toContain('Event Grid boundary checks passed')
})
