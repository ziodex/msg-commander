import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../tests/emulator/', import.meta.url))
const action = process.argv[2] ?? 'up'
if (!['up', 'down', 'status'].includes(action)) throw new Error('Use up, down or status.')
const envPath = new URL('../tests/emulator/.env', import.meta.url)
if (action === 'up') {
	if (process.env.ACCEPT_EULA !== 'Y')
		throw new Error(
			'Set ACCEPT_EULA=Y after reviewing the Service Bus emulator and SQL Server license terms linked in tests/emulator/README.md.',
		)
	let password
	try {
		password = (await readFile(envPath, 'utf8')).match(/^MSSQL_SA_PASSWORD=(.+)$/m)?.[1]
	} catch {
		// First local run.
	}
	password ??= `Bc!9${randomBytes(24).toString('hex')}`
	await writeFile(envPath, `ACCEPT_EULA=Y\nMSSQL_SA_PASSWORD=${password}\n`, { mode: 0o600 })
}
const args = action === 'up' ? ['up', '-d'] : action === 'down' ? ['down'] : ['ps']
const result = spawnSync('docker', ['compose', '-f', 'compose.yaml', ...args], {
	cwd: directory,
	stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (action === 'up') {
	const deadline = Date.now() + 180_000
	let ready = false
	while (Date.now() < deadline) {
		try {
			ready = (
				await fetch('http://127.0.0.1:5300/health', { signal: AbortSignal.timeout(1500) })
			).ok
		} catch {
			// SQL and emulator are starting.
		}
		if (ready) break
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	if (!ready)
		throw new Error(
			'Emulator did not become ready. Inspect docker compose logs in tests/emulator.',
		)
	console.log('Service Bus emulator ready: localhost (AMQP 5672, management 5300).')
}
