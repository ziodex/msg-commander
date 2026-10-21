import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventHubs } from '../../src/renderer/src/features/event-hubs/stores/event-hubs'
import type { DesktopResult } from '../../src/shared/contracts'
import type {
	EventHubSend,
	EventHubSendResult,
} from '../../src/shared/contracts/event-hubs/sending'
let pinia: Pinia
const send = vi.fn<(input: EventHubSend) => Promise<DesktopResult<EventHubSendResult>>>()
const recover = vi.fn()
const setup = {
	hubName: 'events',
	drafts: [{ bodyBase64: '', contentType: '', correlationId: '', properties: [] }],
	routing: { kind: 'automatic' as const },
	repetitions: 1,
	batchSize: 1,
	maxSeconds: 5,
	delayMs: 0,
	acknowledged: true as const,
}
const receipt = (id: string): EventHubSendResult => ({
	operationId: id,
	hubName: 'events',
	routing: { kind: 'automatic' },
	draftCount: 1,
	repetitions: 1,
	totalEvents: 1,
	batchSize: 1,
	maxSeconds: 5,
	delayMs: 0,
	confirmed: 1,
	confirmedBatches: 1,
	uncertain: 0,
	elapsedMs: 10,
	status: 'completed',
	reason: 'count',
	lastBatchFirstIndex: 1,
	lastBatchCount: 1,
	summary: '1 event confirmed.',
	cleanupWarning: null,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', { commander: { sendEventHub: send, getEventHubSendResult: recover } })
	pinia = createPinia()
	setActivePinia(pinia)
	useEventHubs().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		connectedAt: new Date().toISOString(),
		access: 'read',
		managementAvailable: false,
		initialHub: null,
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('blocks another publish after a missing response until its retained receipt is recovered', async () => {
	const store = useEventHubs()
	send.mockResolvedValue({
		ok: false,
		error: { code: 'OUTCOME_UNKNOWN', message: 'Response interrupted.' },
	})
	await store.send(setup)
	const id = store.sendId
	expect(store.sendInterrupted).toBe(true)
	expect(store.sending).toBe(false)
	await store.send(setup)
	expect(send).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await store.recoverSend()
	expect(store.sendInterrupted).toBe(true)
	expect(store.error).toContain('Events may have been accepted')
	recover.mockResolvedValueOnce({ ok: true, value: receipt(id) })
	await store.recoverSend()
	expect(store.sendInterrupted).toBe(false)
	expect(store.sendResult?.confirmed).toBe(1)
	await store.send(setup)
	expect(send).toHaveBeenCalledTimes(1)
	expect(recover.mock.calls[0][0].operationId).toBe(id)
})
it('drops a late send result after connection reset instead of restoring a stale receipt', async () => {
	const store = useEventHubs()
	let finish!: (value: DesktopResult<EventHubSendResult>) => void
	send.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.send(setup),
		id = store.sendId
	expect(store.sending).toBe(true)
	store.reset()
	finish({ ok: true, value: receipt(id) })
	await pending
	expect(store.sendId).toBe('')
	expect(store.sendResult).toBeUndefined()
	expect(store.connection).toBeUndefined()
})
