export function composerBody(
	value: string,
	encoding: 'text' | 'json' | 'base64',
): { base64: string; size: number } {
	if (encoding === 'json') {
		try {
			JSON.parse(value)
		} catch {
			throw new Error(
				'Enter valid JSON. The original text is sent without reformatting numbers.',
			)
		}
	}
	if (encoding === 'base64') {
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
			throw new Error('Enter canonical base64 without whitespace.')
		const size = atob(value).length
		if (size > 262144) throw new Error('Body exceeds the 256 KiB composer limit.')
		return { base64: value, size }
	}
	const bytes = new TextEncoder().encode(value)
	if (bytes.length > 262144) throw new Error('Body exceeds the 256 KiB composer limit.')
	let binary = ''
	for (let i = 0; i < bytes.length; i += 8192)
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
	return { base64: btoa(binary), size: bytes.length }
}
