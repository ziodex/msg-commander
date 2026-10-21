export function decodeBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}
export function utf8Preview(bytes: Uint8Array, complete: boolean): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete })
	} catch {
		return null
	}
}
// Format tokens rather than stringify parsed numbers: large JSON integers must stay exact.
export function prettyJson(text: string): string | null {
	if (text.length > 262144) return null
	try {
		JSON.parse(text)
	} catch {
		return null
	}
	let result = '',
		depth = 0,
		quoted = false,
		escaped = false
	const indent = () => '\n' + '  '.repeat(depth)
	for (let i = 0; i < text.length; i++) {
		if (result.length > 2_000_000) return null
		const character = text[i]
		if (quoted) {
			result += character
			if (escaped) escaped = false
			else if (character === '\\') escaped = true
			else if (character === '"') quoted = false
		} else if (character === '"') {
			quoted = true
			result += character
		} else if (/\s/.test(character)) continue
		else if (character === '{' || character === '[') {
			result += character
			depth++
			if (depth > 64 || result.length > 2_000_000) return null
			let next = i + 1
			while (next < text.length && /\s/.test(text[next])) next++
			if (text[next] !== '}' && text[next] !== ']') result += indent()
		} else if (character === '}' || character === ']') {
			depth--
			if (!/[{[]$/.test(result)) result += indent()
			result += character
		} else if (character === ',') result += ',' + indent()
		else if (character === ':') result += ': '
		else result += character
	}
	return result
}
export function hexPreview(bytes: Uint8Array, start = 0): string {
	const lines: string[] = []
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const slice = bytes.subarray(offset, offset + 16)
		const hex = Array.from(slice, (value) => value.toString(16).padStart(2, '0'))
			.join(' ')
			.padEnd(47, ' ')
		const text = Array.from(slice, (value) =>
			value >= 32 && value <= 126 ? String.fromCharCode(value) : '.',
		).join('')
		lines.push(`${(start + offset).toString(16).padStart(8, '0')}  ${hex}  ${text}`)
	}
	return lines.join('\n')
}

export type JsonToken = {
	text: string
	kind: 'key' | 'string' | 'number' | 'boolean' | 'null' | 'plain'
}
// Tokenize the formatted source, never parsed values; Vue renders each token as escaped text.
export function jsonTokens(text: string): JsonToken[] {
	const tokens: JsonToken[] = []
	const pattern =
		/"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g
	let end = 0
	for (const match of text.matchAll(pattern)) {
		const start = match.index!
		if (start > end) tokens.push({ text: text.slice(end, start), kind: 'plain' })
		const value = match[0]
		end = start + value.length
		const kind = value.startsWith('"')
			? /^\s*:/.test(text.slice(end))
				? 'key'
				: 'string'
			: value === 'null'
				? 'null'
				: value === 'true' || value === 'false'
					? 'boolean'
					: 'number'
		tokens.push({ text: value, kind })
	}
	if (end < text.length) tokens.push({ text: text.slice(end), kind: 'plain' })
	return tokens
}
