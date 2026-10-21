import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.env.COMMANDER_NOTIFICATIONHUBS_DOCKER !== '1')(
	'runs Notification Hubs management and provider updates through the production adapter and Docker HTTP fixture',
	() => {
		expect(
			execFileSync(
				'dotnet',
				[
					resolve(
						'tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll',
					),
					'--nh-management-docker-checks',
				],
				{ encoding: 'utf8', timeout: 60000 },
			),
		).toContain('Notification Hubs management Docker contract checks passed')
	},
	65000,
)
