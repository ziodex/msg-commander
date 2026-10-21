import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.env.COMMANDER_EVENTGRID_DOCKER !== '1')(
	'runs Event Grid publishing, partial settlement, dropped replies and cancellation through the production HTTP adapter and Docker contract fixture',
	() => {
		const output = execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--eventgrid-docker-checks',
			],
			{ encoding: 'utf8', timeout: 60000 },
		)
		expect(output).toContain('Event Grid Docker contract checks passed')
	},
	65000,
)
