import { z } from 'zod'

// Read previous exports, then use the current identity throughout the application.
export function documentFormatSchema<Kind extends string>(kind: Kind) {
	const current = `msg-commander/${kind}` as const
	return z
		.union([z.literal(current), z.literal(`service-bus-commander/${kind}`)])
		.transform(() => current)
}
