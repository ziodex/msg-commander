import { z } from 'zod'
export {
	nhRegistrationsConnectSchema as nhNotificationsConnectSchema,
	nhRegistrationsRequestSchema as nhNotificationsRequestSchema,
	nhRegistrationsConnectionSchema as nhNotificationsConnectionSchema,
	nhRegistrationResultSchema as nhNotificationsResultSchema,
} from './registrations'
export type {
	NotificationHubRegistrationsConnect as NotificationSenderConnect,
	NotificationHubRegistrationsConnection as NotificationSenderConnection,
	NotificationHubRegistrationsRequest as NotificationSenderRequest,
	NotificationHubRegistrationResult as NotificationSenderResult,
} from './registrations'
export function tagExpressionError(expression: string): string | undefined {
	const invalid =
		'Use tags with &&, ||, ! and parentheses; maximum 20 OR tags, 10 AND tags or 6 combined, with nesting up to 16.'
	if (!expression.trim() || expression.length > 1024 || /[\x00-\x1f\x7f]/.test(expression))
		return invalid
	let offset = 0,
		count = 0,
		and = false,
		or = false,
		negated = false
	const space = () => {
		while (expression[offset] === ' ') offset++
	}
	const take = (token: string) => {
		space()
		if (!expression.startsWith(token, offset)) return false
		offset += token.length
		return true
	}
	function primary(depth: number) {
		if (depth > 16) throw Error()
		if (take('!')) {
			negated = true
			primary(depth + 1)
			return
		}
		if (take('(')) {
			parseOr(depth + 1)
			if (!take(')')) throw Error()
			return
		}
		space()
		const match = expression.slice(offset).match(/^[A-Za-z0-9_@#.:~-]{1,120}/)
		if (!match || ['.', '..'].includes(match[0])) throw Error()
		offset += match[0].length
		count++
	}
	function parseAnd(depth: number) {
		primary(depth)
		while (take('&&')) {
			and = true
			primary(depth)
		}
	}
	function parseOr(depth: number) {
		parseAnd(depth)
		while (take('||')) {
			or = true
			parseAnd(depth)
		}
	}
	try {
		parseOr(0)
		space()
		if (offset !== expression.length || count > (and && !or ? 10 : !and && !negated ? 20 : 6))
			return invalid
	} catch {
		return invalid
	}
}
export const notificationFormats = [
	'apple',
	'FcmV1',
	'windows',
	'windowsphone',
	'adm',
	'baidu',
	'browser',
	'template',
] as const
export const notificationFormatLabels: Record<(typeof notificationFormats)[number], string> = {
	apple: 'Apple APNS',
	FcmV1: 'Android FCM v1',
	windows: 'Windows WNS',
	windowsphone: 'Windows Phone MPNS (legacy)',
	adm: 'Amazon ADM',
	baidu: 'Baidu',
	browser: 'Browser Web Push',
	template: 'Template (all matching platforms)',
}
export const notificationHeaders: Record<(typeof notificationFormats)[number], string[]> = {
	apple: [
		'apns-push-type',
		'apns-priority',
		'apns-expiration',
		'apns-collapse-id',
		'apns-topic',
		'ServiceBusNotification-Apns-Expiry',
	],
	windows: ['X-WNS-Type', 'X-WNS-TTL', 'X-WNS-Cache-Policy', 'X-WNS-Tag', 'X-WNS-SuppressPopup'],
	windowsphone: ['X-WindowsPhone-Target', 'X-NotificationClass'],
	baidu: ['X-Baidu-Message-Type'],
	browser: [],
	FcmV1: [],
	adm: [],
	template: [],
}
const utf8 = (s: string) => new TextEncoder().encode(s).length
export const notificationDraftSchema = z
	.object({
		format: z.enum(notificationFormats),
		target: z.enum(['tags', 'broadcast']),
		tagExpression: z.string().max(1024),
		body: z.string().max(65536),
		parameters: z
			.array(
				z
					.object({
						name: z
							.string()
							.min(1)
							.max(128)
							.refine((s) => !/[\x00-\x1f\x7f]/.test(s)),
						value: z.string().max(65536),
					})
					.strict(),
			)
			.max(100),
		headers: z
			.array(
				z
					.object({
						name: z.string().max(128),
						value: z
							.string()
							.min(1)
							.max(512)
							.regex(/^[\x20-\x7e]+$/),
					})
					.strict(),
			)
			.max(12),
	})
	.strict()
	.superRefine((v, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
		if (v.target === 'tags') {
			const error = tagExpressionError(v.tagExpression)
			if (error) issue(error)
		} else if (v.tagExpression !== '') issue('Broadcast cannot include a tag expression.')
		if (v.format === 'template') {
			if (
				v.body !== '' ||
				v.headers.length ||
				!v.parameters.length ||
				new Set(v.parameters.map((p) => p.name.toLowerCase())).size !== v.parameters.length
			)
				issue(
					'Use unique template parameter names and string values; native payload and headers must be empty.',
				)
			if (
				utf8(
					JSON.stringify(Object.fromEntries(v.parameters.map((p) => [p.name, p.value]))),
				) > 65536
			)
				issue('Template payload exceeds 64 KiB UTF-8.')
		} else {
			if (!v.body.trim() || v.parameters.length || utf8(v.body) > 65536)
				issue('Enter a native payload up to 64 KiB UTF-8, without template parameters.')
			if (['apple', 'FcmV1', 'adm', 'baidu', 'browser'].includes(v.format)) {
				try {
					const body = JSON.parse(v.body)
					if (
						!body ||
						Array.isArray(body) ||
						typeof body !== 'object' ||
						(v.format === 'apple' &&
							(!body.aps ||
								Array.isArray(body.aps) ||
								typeof body.aps !== 'object')) ||
						(v.format === 'FcmV1' &&
							(!body.message ||
								Array.isArray(body.message) ||
								typeof body.message !== 'object'))
					)
						issue('Use a JSON object with aps for APNS or message for FCM v1.')
				} catch {
					issue('Enter valid JSON.')
				}
			}
		}
		if (
			new Set(v.headers.map((h) => h.name.toLowerCase())).size !== v.headers.length ||
			v.headers.some(
				(h) =>
					!notificationHeaders[v.format].some(
						(n) => n.toLowerCase() === h.name.toLowerCase(),
					),
			)
		)
			issue('Use unique supported headers for the selected platform.')
		const header = (name: string) =>
			v.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
		if (
			v.format === 'windows' &&
			!['wns/toast', 'wns/tile', 'wns/badge', 'wns/raw'].includes(header('X-WNS-Type') ?? '')
		)
			issue('Choose a supported X-WNS-Type.')
		if (
			v.format === 'windowsphone' &&
			(!['1', '2', '3'].includes(header('X-NotificationClass') ?? '') ||
				![undefined, 'toast', 'token'].includes(header('X-WindowsPhone-Target')))
		)
			issue('Select MPNS notification class 1 (tile), 2 (toast) or 3 (raw).')
		if (header('apns-priority') && !['5', '10'].includes(header('apns-priority')!))
			issue('APNS priority must be 5 or 10.')
		if (header('apns-expiration') && !/^-?\d{1,18}$/.test(header('apns-expiration')!))
			issue('APNS expiration must be a Unix timestamp.')
		if (
			header('ServiceBusNotification-Apns-Expiry') &&
			!Number.isFinite(Date.parse(header('ServiceBusNotification-Apns-Expiry')!))
		)
			issue('Enter an APNS expiry date and time.')
		if (header('X-Baidu-Message-Type') && !['0', '1'].includes(header('X-Baidu-Message-Type')!))
			issue('Baidu message type must be 0 or 1.')
	})
export const notificationSendSchema = z
	.object({
		id: z.string().uuid(),
		connectionId: z.string().uuid(),
		draft: notificationDraftSchema,
		acknowledge: z.literal(true),
	})
	.strict()
export const notificationOutcomeSchema = z
	.object({
		operationId: z.string().uuid(),
		status: z.enum(['confirmed', 'failed', 'cancelled', 'unknown']),
		summary: z.string().max(2048),
		capturedAt: z.string().max(64),
		draft: notificationDraftSchema,
		details: z
			.object({
				success: z.number().int().min(0).max(1000000).nullable(),
				failure: z.number().int().min(0).max(1000000).nullable(),
				results: z
					.array(
						z
							.object({
								platform: z.string().max(4096),
								pnsHandle: z.string().max(4096),
								registrationId: z.string().max(4096),
								outcome: z.string().max(4096),
							})
							.strict(),
					)
					.max(100),
				trackingId: z.string().uuid(),
				notificationId: z.string().max(256).nullable(),
				rawXml: z.string().max(131072).nullable(),
				warning: z.string().max(1024).nullable(),
			})
			.strict()
			.nullable(),
	})
	.strict()
export type NotificationDraft = z.infer<typeof notificationDraftSchema>
export type NotificationSend = z.infer<typeof notificationSendSchema>
export type NotificationOutcome = z.infer<typeof notificationOutcomeSchema>
export function defaultNotification(
	format: NotificationDraft['format'] = 'apple',
): NotificationDraft {
	return {
		format,
		target: 'tags',
		tagExpression: '',
		parameters:
			format === 'template' ? [{ name: 'message', value: 'Hello from Msg Commander' }] : [],
		headers:
			format === 'windows'
				? [{ name: 'X-WNS-Type', value: 'wns/toast' }]
				: format === 'windowsphone'
					? [
							{ name: 'X-WindowsPhone-Target', value: 'toast' },
							{ name: 'X-NotificationClass', value: '2' },
						]
					: [],
		body: {
			apple: '{\n  "aps": { "alert": "Hello from Msg Commander" }\n}',
			FcmV1: '{\n  "message": { "notification": { "title": "Commander", "body": "Hello" } }\n}',
			windows:
				'<toast><visual><binding template="ToastText01"><text id="1">Hello</text></binding></visual></toast>',
			windowsphone:
				'<wp:Notification xmlns:wp="WPNotification"><wp:Toast><wp:Text1>Commander</wp:Text1><wp:Text2>Hello</wp:Text2></wp:Toast></wp:Notification>',
			adm: '{"data":{"message":"Hello"}}',
			baidu: '{"title":"Commander","description":"Hello"}',
			browser: '{"title":"Commander","body":"Hello"}',
			template: '',
		}[format],
	}
}
