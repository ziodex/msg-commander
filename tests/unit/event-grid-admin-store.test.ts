import { reactive } from 'vue'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventGrid } from '../../src/renderer/src/features/event-grid/stores/event-grid'
import { useWorkspace } from '../../src/renderer/src/shared/workspace/store'
import { eventGridTopic } from '../../src/shared/contracts/event-grid/core'
import type {
	EventGridAdminChange,
	EventGridAdminOutcome,
} from '../../src/shared/contracts/event-grid/administration'
const change = vi.fn(),
	result = vi.fn(),
	list = vi.fn(),
	read = vi.fn()
let pinia: Pinia
const setup = (): Omit<EventGridAdminChange, 'id' | 'connectionId'> => ({
	target: eventGridTopic('new-topic'),
	action: 'create',
	expectedRevision: null,
	retentionDays: 7,
	settings: null,
	destination: null,
	acknowledged: true,
	confirmation: null,
})
const receipt = (status: EventGridAdminOutcome['status'] = 'confirmed'): EventGridAdminOutcome => ({
	operationId: crypto.randomUUID(),
	target: eventGridTopic('new-topic'),
	action: 'create',
	status,
	summary: 'Azure change ' + status,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			changeEventGrid: change,
			getEventGridAdminResult: result,
			listEventGrid: list,
			getEventGridAdmin: read,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useEventGrid().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.westeurope-1.eventgrid.azure.net',
		resourceId: '/fixture',
		location: 'westeurope',
		connectedAt: new Date().toISOString(),
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('blocks writes on missing final responses while allowing reads and requiring explicit review', async () => {
	const store = useEventGrid()
	change.mockRejectedValue(new Error('Lost IPC'))
	await store.change(setup())
	expect(store.outcome?.status).toBe('unknown')
	expect(store.writeBlocked).toBe(true)
	expect(store.blocked).toBe(false)
	await store.change(setup())
	expect(change).toHaveBeenCalledTimes(1)
	list.mockResolvedValue({ ok: true, value: { items: [], continuationToken: null } })
	await store.loadTopics()
	expect(list).toHaveBeenCalledOnce()
	store.reviewed = true
	expect(store.writeBlocked).toBe(false)
	expect(useWorkspace().jobs[0].status).toBe('completed')
	expect(useWorkspace().jobs[1].status).toBe('unknown')
})
it('recovers a receipt without replay and preserves uncertainty when none is available', async () => {
	const store = useEventGrid(),
		prior = receipt('unknown')
	store.outcome = prior
	result.mockResolvedValueOnce({ ok: true, value: null })
	await store.recover()
	expect(store.outcome).toEqual(prior)
	expect(store.error).toContain('does not prove')
	expect(change).not.toHaveBeenCalled()
	const confirmed = { ...prior, status: 'confirmed' as const }
	result.mockResolvedValueOnce({ ok: true, value: confirmed })
	await store.recover()
	expect(store.outcome?.status).toBe('confirmed')
	expect(store.writeBlocked).toBe(false)
})
it('reports accepted provisioning separately and retains receipts if refresh fails', async () => {
	const store = useEventGrid(),
		value = receipt('accepted')
	change.mockResolvedValue({ ok: true, value })
	expect(await store.change(setup())).toEqual(value)
	expect(store.writeBlocked).toBe(true)
	expect(useWorkspace().jobs[0].status).toBe('accepted')
	expect(useWorkspace().jobs[0].message).toContain(value.operationId)
	list.mockResolvedValue({ ok: false, error: { code: 'AZURE', message: 'Refresh denied' } })
	await store.afterChange(value)
	expect(store.outcome).toEqual(value)
	expect(store.error).toBe('Refresh denied')
})
it('loads additional pages to reveal a newly created entity and stops after failed paging', async () => {
	const store = useEventGrid(),
		token = crypto.randomUUID(),
		value = receipt()
	list.mockResolvedValueOnce({
		ok: true,
		value: { items: [], continuationToken: token },
	}).mockResolvedValueOnce({ ok: false, error: { code: 'AZURE', message: 'Offline' } })
	await store.afterChange(value)
	expect(list).toHaveBeenCalledTimes(2)
	expect(store.topics?.continuationToken).toBe(token)
	expect(store.error).toBe('Offline')
})
it('discards late mutation results after reset and sends cloneable nested filter settings', async () => {
	const store = useEventGrid()
	let finish!: (v: unknown) => void
	change.mockImplementation((v) => {
		expect(() => structuredClone(v)).not.toThrow()
		return new Promise((resolve) => {
			finish = resolve
		})
	})
	const payload = setup()
	payload.target = { kind: 'subscription', topicName: 'orders', subscriptionName: 'new-sub' }
	payload.retentionDays = null
	payload.settings = {
		deliveryMode: 'Queue',
		receiveLockDurationInSeconds: 60,
		maxDeliveryCount: 10,
		eventTimeToLive: 'P1D',
		expirationTimeUtc: null,
		includedEventTypes: ['Order.Created'],
		filters: [
			{
				key: 'data.total',
				operatorType: 'NumberGreaterThan',
				operandJson: '9007199254740993',
			},
		],
	}
	const pending = store.change(reactive(payload))
	store.reset()
	finish({ ok: true, value: receipt() })
	await pending
	expect(store.outcome).toBeUndefined()
	expect(store.connection).toBeUndefined()
})
it('retains known failures with failed job status and allows a freshly reviewed next action', async () => {
	const store = useEventGrid()
	change.mockResolvedValue({ ok: true, value: receipt('failed') })
	await store.change(setup())
	expect(store.outcome?.status).toBe('failed')
	expect(store.writeBlocked).toBe(false)
	expect(useWorkspace().jobs[0].status).toBe('failed')
})
