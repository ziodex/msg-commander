import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME } from '../../shared/branding'

const previousName = 'Service Bus Commander'

// Reuse an existing profile so OS-encrypted credentials and preferences remain available.
export function applicationIdentity(appData: string, override?: string) {
	if (override) return { userData: override, storageName: APP_NAME }
	const current = join(appData, APP_NAME)
	const previous = join(appData, previousName)
	if (
		!existsSync(join(current, 'workspace.json')) &&
		existsSync(join(previous, 'workspace.json'))
	)
		return { userData: previous, storageName: previousName }
	return { userData: current, storageName: APP_NAME }
}
