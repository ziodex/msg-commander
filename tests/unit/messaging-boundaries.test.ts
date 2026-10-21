import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('preserves native AMQP data, receiver ownership, session-only headers and protocol error mapping', () => {
	const result = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--messaging-boundary-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(result).toContain('Messaging boundary checks passed')
})
