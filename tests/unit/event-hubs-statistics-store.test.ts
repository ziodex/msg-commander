import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventHubs } from '../../src/renderer/src/features/event-hubs/stores/event-hubs'
import type { EventHubStatistics } from '../../src/shared/contracts/event-hubs/core'
let pinia: Pinia
const refresh = vi.fn(),
	copy = vi.fn()
const snapshot = (name = 'telemetry'): EventHubStatistics => ({
	hub: { name, partitionIds: ['0'], createdAt: new Date().toISOString() },
	startedAt: new Date().toISOString(),
	capturedAt: new Date().toISOString(),
	partitions: [],
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: { getEventHubStatistics: refresh, copyEventHubUrl: copy },
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
it('preserves the previous timestamp on failed refresh and clears it for a different hub', async () => {
	const eh = useEventHubs(),
		first = snapshot()
	refresh.mockResolvedValueOnce({ ok: true, value: first })
	await eh.refreshStatistics('telemetry')
	expect(eh.statistics).toEqual(first)
	refresh.mockResolvedValue({ ok: false, error: { code: 'cancelled', message: 'Cancelled' } })
	await eh.refreshStatistics('telemetry')
	expect(eh.statistics).toEqual(first)
	await eh.refreshStatistics('other')
	expect(eh.statistics).toBeUndefined()
})
it('drops late snapshot and copy results after connection reset', async () => {
	const eh = useEventHubs()
	let finish!: (v: unknown) => void
	refresh.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = eh.refreshStatistics('telemetry')
	eh.reset()
	finish({ ok: true, value: snapshot() })
	await pending
	expect(eh.statistics).toBeUndefined()
	eh.connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		connectedAt: new Date().toISOString(),
		access: 'read',
		managementAvailable: false,
		initialHub: null,
	}
	copy.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const copying = eh.copyUrl({ kind: 'namespace' })
	eh.reset()
	finish({ ok: true, value: null })
	await copying
	expect(eh.urlNotice).toBe('')
})
it('skips refreshes while another job is active and forwards scoped URL requests', async () => {
	const eh = useEventHubs()
	eh.busy = 'Listening'
	await eh.refreshStatistics('telemetry')
	expect(refresh).not.toHaveBeenCalled()
	eh.busy = ''
	copy.mockResolvedValue({ ok: true, value: null })
	await eh.copyUrl({ kind: 'group', hubName: 'telemetry', consumerGroup: '$Default' }, 'sb')
	expect(copy).toHaveBeenCalledWith({
		id: expect.any(String),
		connectionId: eh.connection!.connectionId,
		scheme: 'sb',
		target: { kind: 'group', hubName: 'telemetry', consumerGroup: '$Default' },
	})
	expect(eh.urlNotice).toBe('SB group URL copied.')
})
