import { z } from 'zod'
export const desktopPreferencesSchema = z
	.object({
		font: z.enum(['plex', 'system', 'mono']),
		accent: z.enum(['warm', 'blue', 'teal']),
		scale: z.union([
			z.literal(0.85),
			z.literal(1),
			z.literal(1.15),
			z.literal(1.25),
			z.literal(1.5),
		]),
	})
	.strict()
export type DesktopPreferences = z.infer<typeof desktopPreferencesSchema>
export const defaultDesktopPreferences: DesktopPreferences = {
	font: 'plex',
	accent: 'warm',
	scale: 1,
}
export const operationLogSchema = z
	.object({
		destination: z.enum(['clipboard', 'file']),
		entries: z
			.array(
				z
					.object({
						id: z.uuid(),
						timestamp: z.iso.datetime(),
						label: z.string().max(1024),
						status: z.enum([
							'running',
							'completed',
							'cancelled',
							'failed',
							'accepted',
							'unknown',
						]),
						message: z.string().max(8192),
					})
					.strict(),
			)
			.min(1)
			.max(500),
	})
	.strict()
export type OperationLogRequest = z.infer<typeof operationLogSchema>
export function redactOperationText(text: string) {
	return text
		.replace(/SharedAccessSignature\s+[^\r\n]+/gi, '[redacted SAS]')
		.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
		.replace(
			/((?:SharedAccessKey|AccountKey|Password|ClientSecret|AccessToken|RefreshToken|sig|token)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&,\r\n]+)/gi,
			'$1[redacted]',
		)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
export function formatOperationLog(input: OperationLogRequest) {
	return input.entries
		.map(
			(entry) =>
				`[${entry.timestamp}] ${entry.status.toUpperCase()} ${redactOperationText(entry.label)}\n${redactOperationText(entry.message)}\n`,
		)
		.join('\n')
}
