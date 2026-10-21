import { z } from 'zod'
import { eventGridHostSchema } from '../event-grid/core'
import { iotEndpointHostSchema, parseIotEndpoint } from '../../iot-hub'

export const serviceSchema = z.enum([
	'service-bus',
	'event-hubs',
	'iot-hub',
	'relay',
	'notification-hubs',
	'event-grid',
])

export const themeSchema = z.enum(['light', 'dark', 'system'])

export const idSchema = z.string().uuid()

export const profileInputSchema = z
	.object({
		id: idSchema,
		name: z.string().trim().min(1).max(80),
		service: serviceSchema,
		namespace: z
			.string()
			.trim()
			.toLowerCase()
			.max(253)
			.regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
		emulatorManagementPort: z.number().int().min(1).max(65535).optional(),
		auth: z.enum(['sas', 'device-code']),
		tenantId: z
			.string()
			.max(100)
			.regex(/^[a-zA-Z0-9.-]*$/)
			.default(''),
		clientId: z.union([z.literal(''), idSchema]).default(''),
		secret: z.string().max(8192).optional(),
		rememberSecret: z.boolean().default(false),
	})
	.strict()
	.superRefine((value, ctx) => {
		const emulator = value.emulatorManagementPort !== undefined
		if (emulator && (value.service !== 'service-bus' || value.auth !== 'sas'))
			ctx.addIssue({
				code: 'custom',
				message: 'The local emulator uses a Service Bus connection string.',
			})
		if (!emulator && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value.namespace))
			ctx.addIssue({
				code: 'custom',
				message: 'Enter the full Azure namespace hostname, or select Local emulator.',
			})
		if (
			value.service === 'service-bus' &&
			value.secret &&
			/(?:^|;)\s*UseDevelopmentEmulator\s*=\s*true\s*(?:;|$)/i.test(value.secret) !== emulator
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Local emulator requires UseDevelopmentEmulator=true; Azure connections must omit it.',
			})
		if (
			value.service === 'event-grid' &&
			(!eventGridHostSchema.safeParse(value.namespace).success ||
				value.auth !== 'device-code')
		)
			ctx.addIssue({
				code: 'custom',
				message:
					'Event Grid resource discovery requires Entra and the namespace HTTP topics hostname.',
			})
		if (value.service === 'iot-hub') {
			if (value.auth !== 'sas' || !iotEndpointHostSchema.safeParse(value.namespace).success)
				ctx.addIssue({
					code: 'custom',
					message:
						'IoT Hub requires a ServiceConnect connection string and its Event Hubs-compatible hostname.',
				})
			if (value.secret) {
				try {
					if (parseIotEndpoint(value.secret).namespace !== value.namespace)
						ctx.addIssue({
							code: 'custom',
							message: 'The IoT Hub endpoint must match the profile hostname.',
						})
				} catch (error) {
					ctx.addIssue({
						code: 'custom',
						message:
							error instanceof Error ? error.message : 'Invalid IoT Hub endpoint.',
					})
				}
			}
		}
		if (value.auth === 'device-code' && (!value.tenantId || !value.clientId))
			ctx.addIssue({
				code: 'custom',
				message: 'Tenant and public client application IDs are required.',
			})
	})

export type ProfileInput = z.infer<typeof profileInputSchema>

export type Profile = Omit<ProfileInput, 'secret' | 'rememberSecret'> & {
	secretState: 'none' | 'session' | 'protected' | 'locked'
}

export type Theme = z.infer<typeof themeSchema>

export type Service = z.infer<typeof serviceSchema>
