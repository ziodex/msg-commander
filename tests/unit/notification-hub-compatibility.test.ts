import { expect, it } from 'vitest'
import { credentialDraftSchema } from '../../src/shared/contracts/notification-hubs/credentials'

it('requires explicit, strict provider removal and modern credential shapes', () => {
	for (const endpoint of ['', 'not a URL', 'https://'])
		expect(
			credentialDraftSchema.safeParse({ provider: 'xiaomi', appSecret: 'secret', endpoint })
				.success,
		).toBe(false)
	expect(credentialDraftSchema.safeParse({ provider: 'gcm-legacy', remove: true }).success).toBe(
		true,
	)
	expect(
		credentialDraftSchema.safeParse({ provider: 'gcm-legacy', apiKey: 'retired' }).success,
	).toBe(false)
	expect(
		credentialDraftSchema.safeParse({
			provider: 'browser',
			remove: true,
			vapidPrivateKey: 'extra',
		}).success,
	).toBe(false)
	expect(
		credentialDraftSchema.safeParse({
			provider: 'xiaomi',
			appSecret: 'secret',
			endpoint: 'https://evil.invalid/v3/message/regid',
		}).success,
	).toBe(false)
	expect(
		credentialDraftSchema.safeParse({
			provider: 'xiaomi',
			appSecret: 'secret',
			endpoint: 'https://api.xmpush.xiaomi.com/v3/message/regid',
		}).success,
	).toBe(true)
})
