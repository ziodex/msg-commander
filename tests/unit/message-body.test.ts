import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
	decodeBase64,
	hexPreview,
	prettyJson,
	utf8Preview,
} from '../../src/renderer/src/shared/lib/message-body'
import { peekRequestSchema, sequenceSchema } from '../../src/shared/service-bus'
it('keeps JSON number tokens and escaped strings exact while formatting', () => {
	const json = '{"n":9007199254740993,"s":"escaped \\\" quote","a":[{},[],1.200e+42]}'
	const formatted = prettyJson(json)!
	expect(formatted).toContain('9007199254740993')
	expect(formatted).toContain('1.200e+42')
	expect(JSON.parse(formatted)).toEqual(JSON.parse(json))
	expect(prettyJson('[broken')).toBeNull()
	expect(prettyJson('['.repeat(10000) + '0' + ']'.repeat(10000))).toBeNull()
	expect(prettyJson('['.repeat(64) + '0,'.repeat(20000) + '0' + ']'.repeat(64))).toBeNull()
})
it('decodes bytes losslessly and tolerates trailing partial UTF-8 only for partial previews', () => {
	const bytes = decodeBase64('AP+AQQ==')
	expect([...bytes]).toEqual([0, 255, 128, 65])
	expect(utf8Preview(bytes, true)).toBeNull()
	const unicode = new TextEncoder().encode('Málaga 🚀')
	expect(utf8Preview(unicode.subarray(0, unicode.length - 1), false)).toBe('Málaga ')
	expect(utf8Preview(unicode.subarray(0, unicode.length - 1), true)).toBeNull()
	expect(utf8Preview(unicode, true)).toBe('Málaga 🚀')
	expect(hexPreview(bytes, 65536)).toContain('00010000  00 ff 80 41')
})
it('validates decimal Int64 cursors and refuses topics as peek targets', () => {
	for (const value of ['0', '9007199254740993', '9223372036854775807'])
		expect(sequenceSchema.safeParse(value).success).toBe(true)
	for (const value of ['-1', '1e4', '9223372036854775808', '1.5'])
		expect(sequenceSchema.safeParse(value).success).toBe(false)
	expect(
		peekRequestSchema.safeParse({
			id: randomUUID(),
			connectionId: randomUUID(),
			target: { kind: 'topic', name: 'events' },
			subQueue: 'active',
			fromSequenceNumber: '0',
			maxMessages: 10,
		}).success,
	).toBe(false)
})

it('highlights JSON tokens without changing lexemes, whitespace or HTML-like string data', async () => {
	const { jsonTokens } = await import('../../src/renderer/src/shared/lib/message-body')
	const source = prettyJson(
		'{"key\\\"": "<script>alert(1)</script>","n":9007199254740993,"decimal":1.200e+42,"a":[true,false,null,{"nested":"value"}]}',
	)!
	const tokens = jsonTokens(source)
	expect(tokens.map((token) => token.text).join('')).toBe(source)
	expect(tokens.filter((token) => token.kind === 'key').map((token) => token.text)).toEqual([
		'"key\\\""',
		'"n"',
		'"decimal"',
		'"a"',
		'"nested"',
	])
	expect(tokens).toContainEqual({ kind: 'number', text: '9007199254740993' })
	expect(tokens).toContainEqual({ kind: 'number', text: '1.200e+42' })
	expect(tokens).toContainEqual({ kind: 'boolean', text: 'false' })
	expect(tokens).toContainEqual({ kind: 'null', text: 'null' })
	expect(tokens).toContainEqual({ kind: 'string', text: '"<script>alert(1)</script>"' })
})
