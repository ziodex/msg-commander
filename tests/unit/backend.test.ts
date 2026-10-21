import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { Backend } from '../../src/main/platform/backend'
import { encodeFrame, FrameDecoder } from '../../src/main/platform/transport/framing'

const dll = resolve('backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll')
let backend: Backend | undefined
afterEach(async () => {
	await backend?.stop()
	backend = undefined
})
async function start() {
	backend = new Backend('dotnet', [dll])
	await backend.start()
	return backend
}

describe('real .NET host lifecycle', () => {
	it('handshakes, correlates concurrent requests and streams progress', async () => {
		const host = await start()
		const events: { operationId: string }[] = []
		host.on('event', (event) => events.push(event))
		const first = randomUUID(),
			second = randomUUID()
		const results = await Promise.all([
			host.request('diagnostics.run', { operationId: first, durationMs: 50 }),
			host.request('diagnostics.run', { operationId: second, durationMs: 100 }),
		])
		expect(results.every((result) => result.summary.includes('No Azure request'))).toBe(true)
		expect(events.filter((event) => event.operationId === first)).toHaveLength(5)
		expect(events.filter((event) => event.operationId === second)).toHaveLength(5)
		expect(host.status.state).toBe('ready')
		await expect(host.request('host.hello', { protocolVersion: 999 })).rejects.toMatchObject({
			code: '-32000',
		})
	})
	it('cancels and times out without breaking later work', async () => {
		const host = await start()
		const controller = new AbortController()
		const request = host.request(
			'diagnostics.run',
			{ operationId: randomUUID(), durationMs: 8000 },
			{ signal: controller.signal },
		)
		controller.abort()
		await expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
		await expect(
			host.request(
				'diagnostics.run',
				{ operationId: randomUUID(), durationMs: 8000 },
				{ timeout: 30 },
			),
		).rejects.toMatchObject({ code: 'TIMEOUT' })
		await expect(
			host.request('diagnostics.run', { operationId: randomUUID(), durationMs: 10 }),
		).resolves.toHaveProperty('summary')
	})
	it('rejects pending work after a crash and restarts without replaying it', async () => {
		const host = await start()
		const pending = host.request('diagnostics.run', {
			operationId: randomUUID(),
			durationMs: 8000,
		})
		const rejected = expect(pending).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
		;(host as unknown as { child: ChildProcess }).child.kill('SIGKILL')
		await rejected
		expect(host.status.state).toBe('crashed')
		await host.restart()
		expect(host.status.state).toBe('ready')
		await expect(
			host.request('diagnostics.run', { operationId: randomUUID(), durationMs: 0 }),
		).resolves.toHaveProperty('summary')
	})
	it('bounds concurrent requests and stops all pending work on shutdown', async () => {
		const host = await start()
		const work = Array.from({ length: 16 }, () =>
			host
				.request('diagnostics.run', { operationId: randomUUID(), durationMs: 8000 })
				.catch((error) => error.code),
		)
		await expect(host.request('host.hello', { protocolVersion: 1 })).rejects.toMatchObject({
			code: 'BUSY',
		})
		await host.stop()
		expect(await Promise.all(work)).toEqual(Array(16).fill('BACKEND_UNAVAILABLE'))
		expect(host.status.state).toBe('stopped')
	})
	it('reports missing executables as a recoverable startup failure', async () => {
		backend = new Backend(resolve('artifacts/nonexistent-commander-host'))
		await expect(backend.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
		expect(backend.status.state).toBe('crashed')
	})
	it('rejects an oversized frame in the actual host', async () => {
		const child = spawn('dotnet', [dll], { stdio: 'pipe' })
		const exited = once(child, 'exit')
		child.stdin.end(Buffer.from([0, 16, 0, 1]))
		expect((await exited)[0]).toBe(2)
	})
	it('accepts fragmented requests and returns a structured unknown-method error', async () => {
		const child = spawn('dotnet', [dll], { stdio: 'pipe' })
		const decoder = new FrameDecoder()
		const response = new Promise<unknown>((resolveResponse) =>
			child.stdout.on('data', (data) => {
				const frames = decoder.push(data)
				if (frames.length) resolveResponse(frames[0])
			}),
		)
		const id = randomUUID()
		const frame = encodeFrame({ jsonrpc: '2.0', id, method: 'no.such.method', params: {} })
		for (let offset = 0; offset < frame.length; offset += 5)
			child.stdin.write(frame.subarray(offset, offset + 5))
		expect(await response).toMatchObject({ id, error: { code: -32601 } })
		const exited = once(child, 'exit')
		child.stdin.end()
		await exited
	})
})
