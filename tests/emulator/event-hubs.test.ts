import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.env.COMMANDER_EVENTHUBS_EMULATOR !== '1')(
	'runs the Event Hubs application owner, SDK adapters, batching, inspection and local checkpoints against Docker',
	() => {
		const output = execFileSync(
			'dotnet',
			[
				resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
				'--eventhubs-emulator-checks',
			],
			{ encoding: 'utf8', timeout: 130000 },
		)
		expect(output).toContain('Event Hubs emulator checks passed')
	},
	140000,
)
