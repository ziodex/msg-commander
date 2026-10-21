import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventHubs } from '../../src/renderer/src/features/event-hubs/stores/event-hubs'
import { useEventHubsAdmin } from '../../src/renderer/src/features/event-hubs/stores/event-hubs-admin'
import type { DesktopResult } from '../../src/shared/contracts'
import type {
	EventAdminChange,
	EventAdminOutcome,
} from '../../src/shared/contracts/event-hubs/administration'
let pinia: Pinia
const change = vi.fn<(input: EventAdminChange) => Promise<DesktopResult<EventAdminOutcome>>>(),
	recover = vi.fn(),
	key = vi.fn(),
	copy = vi.fn()
const setup: Omit<EventAdminChange, 'id' | 'connectionId'> = {
	target: { kind: 'policy', hubName: '', name: 'publisher' },
	action: 'create',
	expectedRevision: null,
	settings: null,
	userMetadata: null,
	rights: ['Send'],
	keyType: null,
	acknowledged: true,
	confirmation: '',
}
const receipt = (id: string): EventAdminOutcome => ({
	operationId: id,
	target: setup.target,
	action: 'create',
	status: 'confirmed',
	summary: 'Policy created.',
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			changeEventAdminResource: change,
			getEventAdminResult: recover,
			revealEventPolicyKey: key,
			copyEventPolicyKey: copy,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useEventHubs().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		connectedAt: new Date().toISOString(),
		access: 'read',
		managementAvailable: true,
		initialHub: null,
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('blocks duplicate mutations after an unavailable response, and recovers the original receipt', async () => {
	const store = useEventHubsAdmin()
	change.mockRejectedValue(new Error('IPC closed'))
	await store.change(setup)
	const id = store.outcome!.operationId
	expect(store.blocked).toBe(true)
	await store.change(setup)
	expect(change).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await store.recover()
	expect(store.blocked).toBe(true)
	expect(useEventHubs().error).toContain('does not prove the change failed')
	recover.mockResolvedValueOnce({ ok: true, value: receipt(id) })
	await store.recover()
	expect(store.outcome?.status).toBe('confirmed')
	expect(store.blocked).toBe(false)
	expect(recover.mock.calls[0][0].operationId).toBe(id)
})
it('drops a late administration response after connection reset', async () => {
	const store = useEventHubsAdmin()
	let finish!: (value: DesktopResult<EventAdminOutcome>) => void
	change.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.change(setup)
	expect(store.blocked).toBe(true)
	const id = change.mock.calls[0][0].id
	useEventHubs().reset()
	finish({ ok: true, value: receipt(id) })
	await pending
	expect(store.outcome).toBeUndefined()
	expect(store.context).toBeUndefined()
	expect(store.reviewed).toBe(false)
})
it('keeps unknown outcomes unknown after explicit review and resets the review on the next action', async () => {
	const store = useEventHubsAdmin()
	change.mockImplementation(async (input) => ({
		ok: true,
		value: { ...receipt(input.id), status: 'unknown' },
	}))
	await store.change(setup)
	store.reviewed = true
	expect(store.blocked).toBe(false)
	expect(store.outcome?.status).toBe('unknown')
	await store.change(setup)
	expect(change).toHaveBeenCalledTimes(2)
	expect(store.reviewed).toBe(false)
	expect(store.blocked).toBe(true)
})
it('returns only a selected credential to the caller and retains none in the store or jobs', async () => {
	const store = useEventHubsAdmin(),
		target = { kind: 'policy' as const, hubName: 'telemetry', name: 'sender' }
	key.mockResolvedValue({
		ok: true,
		value: { key: 'OFFLINE-SENSITIVE', connectionString: 'OFFLINE-CONNECTION' },
	})
	const value = await store.key(target, 'SecondaryKey')
	expect(value?.key).toBe('OFFLINE-SENSITIVE')
	expect(key.mock.calls[0][0]).toMatchObject({ target, keyType: 'SecondaryKey' })
	expect(JSON.stringify(pinia.state.value)).not.toContain('OFFLINE-SENSITIVE')
	expect(JSON.stringify(pinia.state.value)).not.toContain('OFFLINE-CONNECTION')
	copy.mockResolvedValue({ ok: true, value: null })
	expect(await store.copy(target, 'PrimaryKey', 'connectionString')).toBeNull()
	expect(copy.mock.calls[0][0]).toMatchObject({
		keyType: 'PrimaryKey',
		format: 'connectionString',
	})
})
