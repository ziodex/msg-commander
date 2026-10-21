import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('owns client and receiver generations through reconnect, cancellation, cleanup errors and disposal', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--connection-lifetime-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Connection lifetime checks passed')
})

it('discards a closed AMQP session after network loss while preserving other cleanup failures', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--receiver-disposal-checks',
		],
		{ encoding: 'utf8', timeout: 10000 },
	)
	expect(output).toContain('Receiver disposal checks passed')
})
