import { describe, expect, it } from 'vitest'
import { encodeFrame, FrameDecoder } from '../../src/main/platform/transport/framing'
import { MAX_FRAME_BYTES } from '../../src/shared/contracts'

describe('bounded private pipe framing', () => {
	it('reassembles split UTF-8 frames and coalesced responses without loss', () => {
		const decoder = new FrameDecoder()
		const first = {
			id: 'one',
			result: 'ø 🔒',
			sequence: '9223372036854775807',
			bodyBase64: 'AP+A',
		}
		const frames = Buffer.concat([encodeFrame(first), encodeFrame({ id: 'two' })])
		const result: unknown[] = []
		for (let offset = 0; offset < frames.length; offset += 3)
			result.push(...decoder.push(frames.subarray(offset, offset + 3)))
		expect(result).toEqual([first, { id: 'two' }])
		expect(decoder.hasPartialFrame).toBe(false)
	})
	it('rejects oversized, empty and malformed frames before dispatch', () => {
		for (const size of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
			const header = Buffer.alloc(4)
			header.writeUInt32BE(size)
			expect(() => new FrameDecoder().push(header)).toThrow('Invalid frame length')
		}
		expect(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES))).toThrow()
		expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 123]))).toThrow()
	})
})
