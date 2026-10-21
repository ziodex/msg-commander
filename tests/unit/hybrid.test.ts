import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import {
	hybridRunSchema,
	type HybridRun,
	type HybridProgress,
} from '../../src/shared/contracts/relay/hybrid'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend
const profile = {
	id: randomUUID(),
	name: 'Relay',
	service: 'relay' as const,
	namespace: 'fixture.servicebus.windows.net',
	auth: 'device-code' as const,
	tenantId: 'fixture',
	clientId: randomUUID(),
	rememberSecret: false,
}
const setup = (patch: Partial<HybridRun> = {}): HybridRun => ({
	id: randomUUID(),
	profileId: profile.id,
	name: 'bridge',
	mode: 'http-send',
	method: 'POST',
	body: '{"hello":true}',
	encoding: 'utf8',
	headers: [],
	responseStatus: 200,
	maxCount: 1,
	maxSeconds: 5,
	exchangeSeconds: 2,
	acknowledged: true,
	...patch,
})
async function start() {
	host = new Backend('dotnet', [dll])
	await host.start()
}
const run = (request: HybridRun, signal?: AbortSignal) =>
	host.request(
		'hybrid.run',
		{ request, profile },
		{ signal, waitForCancellation: true, timeout: 12000 },
	)
afterEach(async () => {
	await host?.stop()
})
it('validates the typed request, binary size, routing names and permitted headers', () => {
	expect(hybridRunSchema.safeParse(setup()).success).toBe(true)
	for (const value of [
		setup({ name: 'x/../y' }),
		setup({ headers: [{ name: 'Authorization', value: 'secret' }] }),
		setup({ body: 'a'.repeat(16385) }),
		setup({ maxSeconds: 601 }),
		setup({ method: 'GET', body: 'payload' }),
		setup({ mode: 'stream-send', headers: [{ name: 'Content-Type', value: 'text/plain' }] }),
	])
		expect(hybridRunSchema.safeParse(value).success).toBe(false)
})
it('executes production adapter checks including a real SDK WebSocket stream round trip', () => {
	const output = JSON.parse(
		execFileSync('dotnet', [dll, '--hybrid-checks'], { encoding: 'utf8', timeout: 20000 }),
	)
	expect(output.checks).toHaveLength(5)
})
it('retains and recovers fixed-scope results without replaying a reused job ID', async () => {
	await start()
	const request = setup({ maxCount: 3 })
	const result = await run(request)
	expect(result.exchanges).toHaveLength(3)
	expect(result.status).toBe('completed')
	expect(
		await host.request('hybrid.result', {
			id: randomUUID(),
			profileId: profile.id,
			operationId: request.id,
		}),
	).toEqual(result)
	expect(
		await host.request('hybrid.result', {
			id: randomUUID(),
			profileId: randomUUID(),
			operationId: request.id,
		}),
	).toBeNull()
	await expect(run(request)).rejects.toThrow('already been used')
})
it.each(['http', 'stream'] as const)(
	'runs a concurrent %s listener and sender with bounded results',
	async (kind) => {
		await start()
		const stop = new AbortController()
		const request = setup({ mode: `${kind}-listen`, body: '{"reply":true}' })
		const online = new Promise<void>((resolve) =>
			host.on('event', (e: HybridProgress) => {
				if (
					e.type === 'hybrid-progress' &&
					e.operationId === request.id &&
					e.phase === 'online'
				)
					resolve()
			}),
		)
		const listener = run(request, stop.signal)
		await online
		await expect(run(setup({ mode: `${kind}-listen` }))).rejects.toThrow('one listener')
		const sender = await run(setup({ mode: `${kind}-send` }))
		const receipt = await listener
		expect(sender.exchanges[0].responseBody).toBe(Buffer.from(request.body).toString('base64'))
		expect(receipt.exchanges).toHaveLength(1)
	},
)
it('cancels an idle listener, closes it and allows a fresh listener', async () => {
	await start()
	const controller = new AbortController()
	const request = setup({ mode: 'http-listen', maxCount: 5 })
	const online = new Promise<void>((resolve) =>
		host.on('event', (e: HybridProgress) => {
			if (e.operationId === request.id && e.phase === 'online') resolve()
		}),
	)
	const pending = run(request, controller.signal)
	await online
	controller.abort()
	expect((await pending).status).toBe('cancelled')
	const second = await run(setup({ mode: 'http-listen', maxSeconds: 1 }))
	expect(second.reason).toBe('time')
	expect(second.status).toBe('limited')
})
it('stops at the capture budget and sanitizes access failures and uncertain writes', async () => {
	await start()
	const result = await run(
		setup({ name: 'large', maxCount: 100, maxSeconds: 10, body: 'x'.repeat(16384) }),
	)
	expect(result.reason).toBe('buffer-limit')
	expect(result.exchanges.length).toBeLessThan(20)
	expect(JSON.stringify(result).length).toBeLessThan(524288)
	expect((await run(setup({ name: 'denied' }))).status).toBe('failed')
	const uncertain = await run(setup({ name: 'unknown', maxCount: 5 }))
	expect(uncertain.status).toBe('unknown')
	expect(uncertain.exchanges).toHaveLength(1)
	expect(JSON.stringify(uncertain)).not.toContain('SECRET')
})
it('rejects malformed direct host requests before opening a gateway', async () => {
	await start()
	await expect(run(setup({ maxCount: 0 }))).rejects.toThrow('limits')
	await expect(
		host.request('hybrid.run', {
			request: setup(),
			profile: { ...profile, service: 'service-bus' },
		}),
	).rejects.toThrow('limits')
})
it('reset cancels jobs and discards receipts before accepting fresh work', async () => {
	await start()
	const request = setup({ mode: 'http-listen' })
	const online = new Promise<void>((resolve) =>
		host.on('event', (e: HybridProgress) => {
			if (e.operationId === request.id && e.phase === 'online') resolve()
		}),
	)
	const pending = run(request)
	await online
	await host.request('hybrid.reset', {})
	expect((await pending).status).toBe('cancelled')
	expect(
		await host.request('hybrid.result', {
			id: randomUUID(),
			profileId: profile.id,
			operationId: request.id,
		}),
	).toBeNull()
	expect((await run(setup())).status).toBe('completed')
})
