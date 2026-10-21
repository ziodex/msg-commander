import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useNotificationHubRegistrations } from '../../src/renderer/src/features/notification-hubs/stores/notification-hub-registrations'
import type { NotificationHubJobReview } from '../../src/shared/contracts/notification-hubs/jobs'
let pinia: Pinia
const submit = vi.fn(),
	recover = vi.fn(),
	list = vi.fn(),
	preview = vi.fn()
const review = (): NotificationHubJobReview => ({
	reviewId: crypto.randomUUID(),
	namespace: 'fixture.servicebus.windows.net',
	hubName: 'alerts',
	type: 'ExportRegistrations',
	importFileUri: null,
	outputContainerUri: 'https://fixturestore.blob.core.windows.net/registrations',
	expiresAt: new Date(Date.now() + 600000).toISOString(),
	warnings: [],
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			submitNotificationHubJob: submit,
			getNotificationHubJobResult: recover,
			listNotificationHubJobs: list,
			previewNotificationHubJob: preview,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	const store = useNotificationHubRegistrations()
	store.connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		connectedAt: new Date().toISOString(),
	}
	store.jobReview = review()
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('consumes the review once and preserves accepted as distinct from Azure completion', async () => {
	const store = useNotificationHubRegistrations(),
		reviewId = store.jobReview!.reviewId
	submit.mockImplementation(async (r) => ({
		ok: true,
		value: { operationId: r.id, status: 'accepted', summary: 'Azure accepted', job: null },
	}))
	await store.submitJob()
	await store.submitJob()
	expect(submit).toHaveBeenCalledTimes(1)
	expect(submit.mock.calls[0][0]).toMatchObject({ reviewId, acknowledge: true })
	expect(submit.mock.calls[0][0]).not.toHaveProperty('draft')
	expect(store.jobOutcome?.status).toBe('accepted')
})
it('blocks writes after a lost response and recovers without resubmission', async () => {
	const store = useNotificationHubRegistrations()
	submit.mockRejectedValueOnce(Error('lost'))
	await store.submitJob()
	expect(store.blocked).toBe(true)
	const result = store.jobOutcome!
	store.jobReview = review()
	await store.submitJob()
	expect(submit).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: { ...result, status: 'accepted' } })
	await store.recoverJob()
	expect(recover.mock.calls[0][0].operationId).toBe(result.operationId)
	expect(store.blocked).toBe(false)
	expect(submit).toHaveBeenCalledTimes(1)
})
it('retains the previous successful page when refresh fails', async () => {
	const store = useNotificationHubRegistrations(),
		page = { items: [], capturedAt: new Date().toISOString(), moreAvailable: false }
	store.jobPage = page
	list.mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'Access denied' } })
	await store.listJobs()
	expect(store.jobPage).toEqual(page)
	expect(store.error).toBe('Access denied')
})
it('discards late receipt recovery and resets job state with its registration connection', async () => {
	const store = useNotificationHubRegistrations()
	submit.mockImplementation(async (r) => ({
		ok: true,
		value: { operationId: r.id, status: 'unknown', summary: 'uncertain', job: null },
	}))
	await store.submitJob()
	let finish!: (value: unknown) => void
	recover.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.recoverJob(),
		receipt = { ...store.jobOutcome! }
	store.reset()
	finish({ ok: true, value: receipt })
	await pending
	expect(store.connection).toBeUndefined()
	expect(store.jobOutcome).toBeUndefined()
	expect(store.jobReview).toBeUndefined()
})
