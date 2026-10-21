import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventHubs } from '../../src/renderer/src/features/event-hubs/stores/event-hubs'
import { useEventListener } from '../../src/renderer/src/features/event-hubs/stores/event-hubs-listener'
import type { DesktopResult } from '../../src/shared/contracts'
import type { EventListenResult } from '../../src/shared/contracts/event-hubs/listening'
let pinia: Pinia
const listen = vi.fn(),
	recover = vi.fn()
const setup = {
	hubName: 'events',
	consumerGroup: '$Default',
	start: { kind: 'earliest' as const },
	concurrency: 2,
	maxEvents: 10,
	maxSeconds: 5,
	acknowledged: true as const,
}
const result = (id: string): EventListenResult => ({
	operationId: id,
	hubName: 'events',
	consumerGroup: '$Default',
	concurrency: 2,
	maxEvents: 10,
	maxSeconds: 5,
	status: 'cancelled',
	reason: 'cancelled',
	received: 0,
	elapsedMs: 200,
	partitions: [],
	items: [],
	checkpoint: null,
	summary: 'Cancelled.',
	cleanupWarning: null,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: { listenEventHub: listen, getEventListenerResult: recover },
	})
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
it('blocks another listener after a missing reply until the final receipt is recovered', async () => {
	const store = useEventListener()
	listen.mockRejectedValue(new Error('IPC closed'))
	await store.listen(setup)
	expect(store.interrupted).toBe(true)
	const id = store.operationId
	await store.listen(setup)
	expect(listen).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await store.recover()
	expect(store.interrupted).toBe(true)
	recover.mockResolvedValueOnce({ ok: true, value: result(id) })
	await store.recover()
	expect(store.interrupted).toBe(false)
	expect(store.result?.status).toBe('cancelled')
	expect(recover.mock.calls[0][0].operationId).toBe(id)
})
it('discards late results and checkpoint state after disconnect/reset', async () => {
	const store = useEventListener()
	let finish!: (value: DesktopResult<EventListenResult>) => void
	listen.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
	const pending = store.listen(setup),
		id = store.operationId
	useEventHubs().reset()
	finish({ ok: true, value: result(id) })
	await pending
	expect(store.result).toBeUndefined()
	expect(store.operationId).toBe('')
	expect(store.checkpoint).toBeUndefined()
})
it('permits correcting known validation failures without inventing an interrupted read', async () => {
	const store = useEventListener()
	listen.mockResolvedValue({
		ok: false,
		error: { code: '-32602', message: 'Checkpoint scope mismatch.' },
	})
	await store.listen(setup)
	expect(store.interrupted).toBe(false)
	await store.listen(setup)
	expect(listen).toHaveBeenCalledTimes(2)
})
