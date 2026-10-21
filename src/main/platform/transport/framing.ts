import { MAX_FRAME_BYTES } from '../../../shared/contracts'

export function encodeFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), 'utf8')
	if (!body.length || body.length > MAX_FRAME_BYTES)
		throw new Error('Frame exceeds protocol limit.')
	const header = Buffer.alloc(4)
	header.writeUInt32BE(body.length)
	return Buffer.concat([header, body])
}

export class FrameDecoder {
	private buffer = Buffer.alloc(0)
	push(chunk: Buffer): unknown[] {
		// Node pipe chunks are bounded; decode coalesced frames before retaining a partial frame.
		this.buffer = Buffer.concat([this.buffer, chunk])
		const values: unknown[] = []
		while (this.buffer.length >= 4) {
			const size = this.buffer.readUInt32BE(0)
			if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('Invalid frame length.')
			if (this.buffer.length < size + 4) break
			values.push(JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')))
			this.buffer = this.buffer.subarray(size + 4)
		}
		return values
	}
	get hasPartialFrame() {
		return this.buffer.length > 0
	}
}
