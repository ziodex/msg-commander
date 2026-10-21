import { z } from 'zod'

const header = z
	.string()
	.max(128)
	.regex(/^[^\x00-\x1f\x7f]*$/)
export const preferencesSchema = z
	.object({
		peekCount: z.number().int().min(1).max(25),
		receiveWaitSeconds: z.number().int().min(1).max(20),
		countRefreshSeconds: z
			.number()
			.int()
			.refine((n) => n === 0 || (n >= 10 && n <= 3600)),
		showMessageCounts: z.boolean(),
		messageSubject: header,
		messageContentType: header,
	})
	.strict()
export type Preferences = z.infer<typeof preferencesSchema>
export const defaultPreferences: Preferences = {
	peekCount: 10,
	receiveWaitSeconds: 2,
	countRefreshSeconds: 30,
	showMessageCounts: true,
	messageSubject: '',
	messageContentType: 'application/json',
}
export const preferenceLabels: Record<keyof Preferences, string> = {
	peekCount: 'Messages per peek',
	receiveWaitSeconds: 'Receive wait (seconds)',
	countRefreshSeconds: 'Count refresh (seconds)',
	showMessageCounts: 'Show message counts',
	messageSubject: 'Default message subject',
	messageContentType: 'Default content type',
}
export type SettingsReceipt = { fingerprint: string; appliedAt: string; changed: number }
export type PreferenceState = {
	preferences: Preferences
	revision: number
	stored: boolean
	migrations: SettingsReceipt[]
}
export const savePreferencesSchema = z
	.object({ preferences: preferencesSchema, revision: z.number().int().nonnegative() })
	.strict()
