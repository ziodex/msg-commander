import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns Service Bus generations, coordination, cleanup and request-scoped authentication in Application', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--workspace-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 15000 },
	)
	expect(output).toContain('Workspace boundary checks passed')
})
