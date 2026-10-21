import { z } from 'zod'
export const iotEndpointHostSchema = z
	.string()
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.servicebus\.windows\.net$/i)
const invalid = () =>
	new Error(
		'Paste the Event Hubs-compatible connection string from IoT Hub → Built-in endpoints, including Endpoint, SharedAccessKeyName, SharedAccessKey and EntityPath. Use a policy with ServiceConnect permission; HostName/device connection strings are not supported here.',
	)
// Returns public endpoint metadata only. Never include input values in validation errors.
export function parseIotEndpoint(value: string): { namespace: string; hubName: string } {
	if (!value || value.length > 8192 || /[\r\n\x00]/.test(value)) throw invalid()
	const fields = new Map<string, string>()
	for (const part of value.trim().replace(/;$/, '').split(';')) {
		const at = part.indexOf('=')
		if (at < 1) throw invalid()
		const name = part.slice(0, at).trim().toLowerCase(),
			content = part.slice(at + 1).trim()
		if (
			fields.has(name) ||
			!['endpoint', 'sharedaccesskeyname', 'sharedaccesskey', 'entitypath'].includes(name) ||
			!content
		)
			throw invalid()
		fields.set(name, content)
	}
	const match = /^sb:\/\/([^/]+)\/?$/i.exec(fields.get('endpoint') ?? '')
	const namespace = match?.[1].toLowerCase() ?? '',
		hubName = fields.get('entitypath') ?? ''
	const key = fields.get('sharedaccesskey') ?? ''
	if (
		fields.size !== 4 ||
		!iotEndpointHostSchema.safeParse(namespace).success ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(hubName) ||
		!/^[A-Za-z0-9_.-]{1,256}$/.test(fields.get('sharedaccesskeyname') ?? '') ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(key)
	)
		throw invalid()
	try {
		if (btoa(atob(key)) !== key) throw invalid()
	} catch {
		throw invalid()
	}
	return { namespace, hubName }
}
export const iotHubConnectSchema = z
	.object({ id: z.string().uuid(), profileId: z.string().uuid() })
	.strict()
export type IotHubConnect = z.infer<typeof iotHubConnectSchema>
