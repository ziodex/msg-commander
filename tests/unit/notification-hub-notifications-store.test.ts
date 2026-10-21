import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useNotificationSender } from '../../src/renderer/src/features/notification-hubs/stores/notification-hub-notifications'
import {
	defaultNotification,
	type NotificationOutcome,
} from '../../src/shared/contracts/notification-hubs/notifications'
const send = vi.fn(),
	recover = vi.fn(),
	connect = vi.fn()
let pinia: Pinia
const draft = () => ({ ...defaultNotification(), tagExpression: 'sports' })
const receipt = (
	operationId: string,
	status: NotificationOutcome['status'] = 'confirmed',
): NotificationOutcome => ({
	operationId,
	status,
	summary: 'Fixture send result',
	capturedAt: new Date().toISOString(),
	draft: draft(),
	details: null,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			sendTestNotification: send,
			getTestNotificationResult: recover,
			connectNotificationSender: connect,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useNotificationSender().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		connectedAt: new Date().toISOString(),
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('inspects a receipt with a stable request and closes the composer after sending', async () => {
	const store = useNotificationSender()
	store.composer = true
	send.mockImplementation(async (request) => ({ ok: true, value: receipt(request.id) }))
	await store.send(draft())
	expect(store.outcome?.status).toBe('confirmed')
	expect(store.composer).toBe(false)
	expect(store.inspection).toBe(true)
	expect(send).toHaveBeenCalledTimes(1)
	expect(send.mock.calls[0][0].acknowledge).toBe(true)
})
it('blocks uncertain sends until explicitly reviewed, then permits a new send', async () => {
	const store = useNotificationSender()
	send.mockImplementation(async (request) => ({
		ok: true,
		value: receipt(request.id, 'unknown'),
	}))
	await store.send(draft())
	expect(store.blocked).toBe(true)
	await store.send(draft())
	expect(send).toHaveBeenCalledTimes(1)
	store.reviewed = true
	await store.send(draft())
	expect(send).toHaveBeenCalledTimes(2)
	expect(store.reviewed).toBe(false)
})
it('keeps lost responses uncertain and recovery never resends', async () => {
	const store = useNotificationSender()
	send.mockRejectedValueOnce(Error('lost'))
	await store.send(draft())
	const id = store.outcome!.operationId
	expect(store.outcome?.status).toBe('unknown')
	recover.mockResolvedValueOnce({ ok: true, value: receipt(id) })
	await store.recover()
	expect(recover.mock.calls[0][0].operationId).toBe(id)
	expect(store.outcome?.status).toBe('confirmed')
	expect(send).toHaveBeenCalledTimes(1)
})
it('discard late sends and recoveries after reset', async () => {
	const store = useNotificationSender()
	let finish!: (v: unknown) => void
	send.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.send(draft())
	const id = send.mock.calls[0][0].id
	store.reset()
	finish({ ok: true, value: receipt(id) })
	await pending
	expect(store.outcome).toBeUndefined()
	expect(store.inspection).toBe(false)
	expect(store.connection).toBeUndefined()
})
it('snapshots parameter/header arrays before asynchronous IPC', async () => {
	const store = useNotificationSender()
	const original = { ...defaultNotification('template'), target: 'broadcast' as const }
	let finish!: (v: unknown) => void
	send.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.send(original)
	original.parameters[0].value = 'changed'
	const request = send.mock.calls[0][0]
	expect(request.draft.parameters[0].value).not.toBe('changed')
	finish({ ok: true, value: receipt(request.id) })
	await pending
})
it('connecting does not query registrations or require Manage permissions', async () => {
	const store = useNotificationSender(),
		connection = { ...store.connection! }
	connect.mockResolvedValueOnce({ ok: true, value: connection })
	await store.connect({
		profileId: connection.profileId,
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		policyTarget: null,
		keyType: null,
	})
	expect(store.connection).toEqual(connection)
	expect(connect).toHaveBeenCalledTimes(1)
})
