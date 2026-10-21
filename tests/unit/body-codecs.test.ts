import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import { Backend } from '../../src/main/platform/backend'
import { BodyCodecFiles, decompressBody } from '../../src/main/features/body-tools/files'
import { CODEC_LIMIT, codecRequestSchema, type CodecOptions } from '../../src/shared/body-codecs'
const fixtures = resolve('tests/fixtures/body-tools')
let host: Backend,
	files: BodyCodecFiles,
	directory: string,
	openPath: string | undefined,
	savePath: string | undefined
const signal = () => new AbortController().signal
const read = (file: string) => readFile(join(fixtures, file))
const convert = (bytes: Buffer, options: Partial<CodecOptions> = {}) =>
	files.convert(
		{
			id: randomUUID(),
			contentBase64: bytes.toString('base64'),
			direction: 'decode',
			format: 'text',
			encoding: 'utf8',
			compression: 'none',
			bom: false,
			...options,
		},
		signal(),
	)
beforeAll(async () => {
	host = new Backend('dotnet', [
		resolve('backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll'),
	])
	await host.start()
})
afterAll(async () => {
	await host.stop()
})
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-codec-'))
	openPath = savePath = undefined
	files = new BodyCodecFiles(host, { open: async () => openPath, save: async () => savePath })
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
it.each(['utf8', 'utf16le', 'utf16be', 'utf32le', 'utf32be'] as const)(
	'strictly decodes the independent %s fixture and roundtrips with optional matching BOM',
	async (encoding) => {
		const expected = await read('sample.txt'),
			source = await read(encoding + '.bin')
		expect(Buffer.from((await convert(source, { encoding })).contentBase64, 'base64')).toEqual(
			expected,
		)
		for (const bom of [false, true]) {
			const encoded = await convert(expected, { direction: 'encode', encoding, bom })
			expect(
				Buffer.from(
					(await convert(Buffer.from(encoded.contentBase64, 'base64'), { encoding }))
						.contentBase64,
					'base64',
				),
			).toEqual(expected)
		}
	},
)
it('strictly validates ASCII, UTF-8, UTF-16/32 code points and BOM conflicts instead of replacing characters', async () => {
	expect(
		Buffer.from(
			(await convert(Buffer.from('plain'), { encoding: 'ascii' })).contentBase64,
			'base64',
		).toString(),
	).toBe('plain')
	for (const [bytes, encoding] of [
		[Buffer.from([255]), 'utf8'],
		[Buffer.from([128]), 'ascii'],
		[Buffer.from([0]), 'utf16le'],
		[Buffer.from([0, 216]), 'utf16le'],
		[Buffer.from([0, 0, 17, 0]), 'utf32le'],
		[Buffer.from([255, 254, 65, 0]), 'utf8'],
	] as const)
		await expect(convert(bytes, { encoding })).rejects.toMatchObject({ code: '-32602' })
	await expect(
		convert(Buffer.from('€'), { encoding: 'ascii', direction: 'encode' }),
	).rejects.toMatchObject({ code: '-32602' })
	expect(
		codecRequestSchema.safeParse({
			id: randomUUID(),
			contentBase64: '',
			direction: 'decode',
			format: 'text',
			encoding: 'utf7',
			compression: 'none',
			bom: false,
		}).success,
	).toBe(false)
})
it.each(['gzip', 'deflate'] as const)(
	'decodes the independent %s fixture and re-encodes arbitrary bytes exactly',
	async (compression) => {
		const source = await read(compression + '.bin'),
			expected = await read('sample.txt')
		expect(
			Buffer.from((await convert(source, { compression })).contentBase64, 'base64'),
		).toEqual(expected)
		const raw = Buffer.from([0, 255, 10, 1, 255])
		const encoded = await convert(raw, { format: 'bytes', direction: 'encode', compression })
		expect(
			Buffer.from(
				(
					await convert(Buffer.from(encoded.contentBase64, 'base64'), {
						format: 'bytes',
						compression,
					})
				).contentBase64,
				'base64',
			),
		).toEqual(raw)
	},
)
it('rejects truncated, trailing, multi-member or corrupt GZip and raw Deflate without a silent fallback', async () => {
	const gzip = await read('gzip.bin'),
		deflate = await read('deflate.bin')
	const badCrc = Buffer.from(gzip)
	badCrc[badCrc.length - 8] ^= 1
	const badSize = Buffer.from(gzip)
	badSize[badSize.length - 4] ^= 1
	for (const bytes of [
		gzip.subarray(0, -1),
		gzip.subarray(0, -8),
		Buffer.concat([gzip, Buffer.from([0])]),
		Buffer.concat([gzip, gzip]),
		badCrc,
		badSize,
		Buffer.from('PK\x03\x04'),
	])
		await expect(convert(bytes, { compression: 'gzip' })).rejects.toMatchObject({
			code: 'BODY_CODEC',
		})
	for (const bytes of [
		deflate.subarray(0, -1),
		Buffer.concat([deflate, Buffer.from([0])]),
		Buffer.alloc(0),
	])
		await expect(convert(bytes, { compression: 'deflate' })).rejects.toMatchObject({
			code: 'BODY_CODEC',
		})
})
it('accepts bounded optional GZip headers and refuses an invalid header checksum', async () => {
	const source = await read('gzip-headers.bin')
	expect(
		Buffer.from((await convert(source, { compression: 'gzip' })).contentBase64, 'base64'),
	).toEqual(await read('sample.txt'))
	const corrupt = Buffer.from(source)
	corrupt[15] ^= 1
	await expect(convert(corrupt, { compression: 'gzip' })).rejects.toMatchObject({
		code: 'BODY_CODEC',
	})
})
it('bounds decompression bombs, source bytes, serialized output and canonical base64', async () => {
	for (const compression of ['gzip', 'deflate'] as const) {
		const raw = Buffer.alloc(CODEC_LIMIT + 1, 65)
		const packed = compression === 'gzip' ? gzipSync(raw) : deflateRawSync(raw)
		expect(() => decompressBody(packed, compression)).toThrow('oversized')
	}
	await expect(convert(Buffer.alloc(CODEC_LIMIT + 1))).rejects.toThrow()
	await expect(
		convert(Buffer.alloc(CODEC_LIMIT, 65), {
			format: 'text',
			encoding: 'utf32le',
			direction: 'encode',
		}),
	).rejects.toMatchObject({ code: '-32602' })
	await expect(
		files.convert(
			{
				id: randomUUID(),
				contentBase64: 'Zh==',
				direction: 'decode',
				format: 'bytes',
				encoding: 'utf8',
				compression: 'none',
				bom: false,
			},
			signal(),
		),
	).rejects.toMatchObject({ code: 'BODY_CODEC' })
})
it('keeps source files intact, saves exact reviewed results and invalidates discarded/expired handles', async () => {
	openPath = join(directory, 'source.bin')
	const source = await read('gzip.bin')
	await writeFile(openPath, source)
	const opened = await files.open(signal())
	expect(opened.cancelled).toBe(false)
	if (opened.cancelled) throw new Error('File fixture missing')
	const converted = await convert(Buffer.from(opened.contentBase64, 'base64'), {
		compression: 'gzip',
	})
	savePath = join(directory, 'converted.bin')
	await files.save(converted.resultId, signal())
	expect(await readFile(savePath)).toEqual(await read('sample.txt'))
	expect(await readFile(openPath)).toEqual(source)
	files.discard(converted.resultId)
	await expect(files.save(converted.resultId, signal())).rejects.toThrow(
		'expired or was discarded',
	)
	const second = await convert(Buffer.from('new'))
	const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001)
	try {
		await expect(files.save(second.resultId, signal())).rejects.toThrow(
			'expired or was discarded',
		)
	} finally {
		now.mockRestore()
	}
})
it('handles file cancellation and conversion cancellation without changing sources or creating results', async () => {
	expect((await files.open(signal())).cancelled).toBe(true)
	const result = await convert(Buffer.from('valid'))
	expect((await files.save(result.resultId, signal())).cancelled).toBe(true)
	const controller = new AbortController()
	controller.abort()
	await expect(
		files.convert(
			{
				id: randomUUID(),
				contentBase64: '',
				direction: 'decode',
				format: 'bytes',
				encoding: 'utf8',
				compression: 'none',
				bom: false,
			},
			controller.signal,
		),
	).rejects.toMatchObject({ code: 'CANCELLED' })
})
