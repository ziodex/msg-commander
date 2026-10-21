import { createHash, randomUUID } from 'node:crypto'
import { gzipSync, deflateRawSync, inflateRawSync } from 'node:zlib'
import {
	CODEC_LIMIT,
	codecRequestSchema,
	type CodecRequest,
	type CodecResult,
} from '../../../shared/body-codecs'
import { type Backend, HostError } from '../../platform/backend'
import { readBounded, atomicFile } from '../service-bus/files/message-files'
import { basename } from 'node:path'

function invalid(): never {
	throw new HostError(
		'BODY_CODEC',
		'Body conversion failed. Check the selected compression, format and encoding. Truncated, trailing, corrupt or oversized data was refused; original bytes are retained.',
	)
}
export function codecBytes(value: string): Buffer {
	const bytes = Buffer.from(value, 'base64')
	if (bytes.length > CODEC_LIMIT || bytes.toString('base64') !== value) invalid()
	return bytes
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1
	return n >>> 0
})
function crc32(bytes: Buffer) {
	let value = 0xffffffff
	for (const b of bytes) value = crcTable[(value ^ b) & 255]! ^ (value >>> 8)
	return (value ^ 0xffffffff) >>> 0
}
export function decompressBody(bytes: Buffer, compression: CodecRequest['compression']): Buffer {
	if (bytes.length > CODEC_LIMIT) invalid()
	if (compression === 'none') return bytes
	try {
		let data = bytes
		if (compression === 'gzip') {
			if (
				bytes.length < 18 ||
				bytes[0] !== 31 ||
				bytes[1] !== 139 ||
				bytes[2] !== 8 ||
				bytes[3]! & 0xe0
			)
				invalid()
			const flags = bytes[3]!,
				end = bytes.length - 8
			let offset = 10
			if (flags & 4) {
				if (offset + 2 > end) invalid()
				const length = bytes.readUInt16LE(offset)
				offset += 2 + length
			}
			for (const flag of [8, 16])
				if (flags & flag) {
					while (offset < end && offset <= 8192 && bytes[offset++] !== 0) {}
					if (bytes[offset - 1] !== 0) invalid()
				}
			if (offset > end || offset > 8192) invalid()
			if (flags & 2) {
				if (
					offset + 2 > end ||
					bytes.readUInt16LE(offset) !== (crc32(bytes.subarray(0, offset)) & 0xffff)
				)
					invalid()
				offset += 2
			}
			if (offset >= end) invalid()
			data = bytes.subarray(offset, end)
		}
		const inflated = inflateRawSync(data, {
			maxOutputLength: CODEC_LIMIT,
			info: true,
		}) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
		if (inflated.engine.bytesWritten !== data.length) invalid()
		if (
			compression === 'gzip' &&
			(bytes.readUInt32LE(bytes.length - 8) !== crc32(inflated.buffer) ||
				bytes.readUInt32LE(bytes.length - 4) !== inflated.buffer.length)
		)
			invalid()
		return inflated.buffer
	} catch {
		invalid()
	}
}
export function compressBody(bytes: Buffer, compression: CodecRequest['compression']): Buffer {
	if (bytes.length > CODEC_LIMIT) invalid()
	const result =
		compression === 'none'
			? bytes
			: compression === 'gzip'
				? gzipSync(bytes)
				: deflateRawSync(bytes)
	if (result.length > CODEC_LIMIT) invalid()
	return result
}
export class BodyCodecFiles {
	private results = new Map<string, { result: CodecResult; expires: number }>()
	constructor(
		private backend: Pick<Backend, 'request'>,
		private dialogs: {
			open: () => Promise<string | undefined>
			save: () => Promise<string | undefined>
		},
	) {}
	discard(id: string) {
		this.results.delete(id)
		return null
	}
	private prune() {
		for (const [id, value] of this.results)
			if (value.expires < Date.now()) this.results.delete(id)
	}
	async convert(input: CodecRequest, signal: AbortSignal): Promise<CodecResult> {
		const value = codecRequestSchema.parse(input)
		if (signal.aborted) throw new HostError('CANCELLED', 'Body conversion cancelled.')
		const original = codecBytes(value.contentBase64)
		const bytes =
			value.direction === 'decode' ? decompressBody(original, value.compression) : original
		const converted = await this.backend.request(
			'body.codec',
			{
				direction: value.direction,
				format: value.format,
				encoding: value.encoding,
				bom: value.bom,
				contentBase64: bytes.toString('base64'),
			},
			{ signal },
		)
		if (signal.aborted) throw new HostError('CANCELLED', 'Body conversion cancelled.')
		const output =
			value.direction === 'encode'
				? compressBody(codecBytes(converted.contentBase64), value.compression)
				: codecBytes(converted.contentBase64)
		const result: CodecResult = {
			...converted,
			contentBase64: output.toString('base64'),
			kind:
				value.direction === 'encode' && value.compression !== 'none'
					? 'bytes'
					: converted.kind,
			resultId: randomUUID(),
			byteLength: output.length,
			sha256: createHash('sha256').update(output).digest('hex'),
		}
		if (value.compression !== 'none')
			result.warnings = [
				...result.warnings,
				'Compression is explicit. Review the recipient’s content type and compression metadata before sending.',
			]
		this.prune()
		if (this.results.size >= 8) this.results.delete(this.results.keys().next().value!)
		this.results.set(result.resultId, { result, expires: Date.now() + 600000 })
		return result
	}
	async open(signal: AbortSignal) {
		try {
			const path = await this.dialogs.open()
			if (signal.aborted) throw new HostError('CANCELLED', 'File selection cancelled.')
			if (!path) return { cancelled: true as const }
			const bytes = await readBounded(path, CODEC_LIMIT, signal, '256 KiB')
			return {
				cancelled: false as const,
				contentBase64: bytes.toString('base64'),
				fileName: basename(path),
			}
		} catch (error) {
			if (error instanceof HostError) throw error
			throw new HostError(
				'BODY_CODEC',
				'Body file could not be read. Check access and select a regular file of at most 256 KiB.',
			)
		}
	}
	async save(id: string, signal: AbortSignal) {
		this.prune()
		const value = this.results.get(id)
		if (!value)
			throw new HostError(
				'BODY_CODEC',
				'The conversion expired or was discarded. Convert the body again before saving.',
			)
		try {
			const path = await this.dialogs.save()
			if (!path) return { cancelled: true }
			await atomicFile(path, CODEC_LIMIT, signal, async (write) => {
				await write(codecBytes(value.result.contentBase64))
			})
			return { cancelled: false, fileName: basename(path), count: 1 }
		} catch (error) {
			if (error instanceof HostError) throw error
			throw new HostError(
				'BODY_CODEC',
				'Converted body could not be saved. Check access and available space; source bytes are retained.',
			)
		}
	}
}
