import { createServer, connect, type Socket } from 'node:net'

// Loopback-only faults affect this test client, never the Docker broker or other clients.
export class FaultProxy {
	private sockets = new Set<Socket>()
	private mode: 'online' | 'offline' | 'lose-responses' = 'online'
	private server = createServer((client) => {
		if (this.mode === 'offline') return client.destroy()
		const upstream = connect({ host: '127.0.0.1', port: this.upstreamPort })
		this.connections++
		this.sockets.add(client)
		this.sockets.add(upstream)
		for (const socket of [client, upstream]) {
			socket.on('error', () => socket.destroy())
			socket.on('close', () => {
				this.sockets.delete(socket)
				;(socket === client ? upstream : client).destroy()
			})
		}
		client.on('data', (bytes) => {
			this.forwarded += bytes.length
			if (!upstream.write(bytes)) client.pause()
		})
		upstream.on('drain', () => client.resume())
		upstream.on('data', (bytes) => {
			if (this.mode === 'lose-responses') this.dropped += bytes.length
			else if (!client.write(bytes)) upstream.pause()
		})
		client.on('drain', () => upstream.resume())
	})
	port = 0
	forwarded = 0
	dropped = 0
	connections = 0
	constructor(private readonly upstreamPort: number) {
		if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)
			throw new Error('Invalid loopback upstream port')
	}
	async start() {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject)
			this.server.listen(0, '127.0.0.1', () => {
				this.server.off('error', reject)
				resolve()
			})
		})
		const address = this.server.address()
		if (!address || typeof address === 'string') throw new Error('Missing proxy address')
		this.port = address.port
		return this
	}
	loseResponses() {
		this.mode = 'lose-responses'
	}
	cut() {
		this.mode = 'offline'
		for (const socket of this.sockets) socket.destroy()
	}
	restore() {
		this.mode = 'online'
		for (const socket of this.sockets) socket.destroy()
	}
	async close() {
		this.cut()
		if (this.server.listening)
			await new Promise<void>((resolve, reject) =>
				this.server.close((error) => (error ? reject(error) : resolve())),
			)
	}
}
