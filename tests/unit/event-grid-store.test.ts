import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventGrid } from '../../src/renderer/src/features/event-grid/stores/event-grid'
import { eventGridTopic, type EventGridPage } from '../../src/shared/contracts/event-grid/core'
const list = vi.fn(),
	get = vi.fn(),
	connect = vi.fn(),
	disconnect = vi.fn()
let pinia: Pinia
const page = (names = ['orders'], next: string | null = null): EventGridPage => ({
	items: names.map((name) => ({
		name,
		target: eventGridTopic(name),
		provisioningState: 'Succeeded',
		inputSchema: 'CloudEventSchemaV1_0',
		deliveryMode: null,
	})),
	continuationToken: next,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			listEventGrid: list,
			getEventGrid: get,
			connectEventGrid: connect,
			disconnectEventGrid: disconnect,
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
it('retains pages on failure, retries the same cursor and merges unique topics', async () => {
	const store = useEventGrid(),
		next = crypto.randomUUID()
	list.mockResolvedValueOnce({ ok: true, value: page(['orders'], next) })
	await store.loadTopics()
	list.mockResolvedValueOnce({ ok: false, error: { code: 'AZURE', message: 'Read failed' } })
	await store.loadTopics(true)
	expect(store.topics?.continuationToken).toBe(next)
	list.mockImplementation(async (value) => {
		expect(() => structuredClone(value)).not.toThrow()
		return { ok: true, value: page(['orders', 'archive']) }
	})
	await store.loadTopics(true)
	expect(store.topics?.items.map((i) => i.name)).toEqual(['orders', 'archive'])
	expect(list.mock.calls[1][0].continuationToken).toBe(list.mock.calls[2][0].continuationToken)
})
it('refreshes a parent independently and reconciles removed topics after namespace refresh', async () => {
	const store = useEventGrid()
	store.topics = page(['orders', 'archive'])
	store.subscriptions = { orders: page(), archive: page() }
	store.expanded = ['orders', 'archive']
	list.mockResolvedValue({ ok: true, value: page(['orders']) })
	await store.loadTopics()
	expect(store.expanded).toEqual(['orders'])
	expect(Object.keys(store.subscriptions)).toEqual(['orders'])
})
it('loads children lazily once and preserves them while collapsing and reopening', async () => {
	const store = useEventGrid()
	list.mockResolvedValue({ ok: true, value: page() })
	await store.toggle('orders')
	await store.toggle('orders')
	await store.toggle('orders')
	expect(list).toHaveBeenCalledTimes(1)
	expect(store.expanded).toEqual(['orders'])
})
it('discards late tree pages after reset', async () => {
	const store = useEventGrid()
	let finish!: (v: unknown) => void
	list.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.loadTopics()
	store.reset()
	finish({ ok: true, value: page() })
	await pending
	expect(store.topics).toBeUndefined()
	expect(store.busy).toBe('')
})
it('does not reopen a closed inspector when its read completes', async () => {
	const store = useEventGrid()
	let finish!: (v: unknown) => void
	get.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.inspect(eventGridTopic('orders'))
	store.closeInspection()
	finish({ ok: true, value: { name: 'orders' } })
	await pending
	expect(store.inspection).toBeUndefined()
	expect(store.details).toBeUndefined()
})
it('retains inspected metadata after a failed explicit refresh', async () => {
	const store = useEventGrid()
	get.mockResolvedValueOnce({ ok: true, value: { name: 'orders' } })
	await store.inspect(eventGridTopic('orders'))
	get.mockResolvedValueOnce({ ok: false, error: { code: 'AZURE', message: 'Refresh failed' } })
	await store.refreshInspection()
	expect(store.details?.name).toBe('orders')
	expect(store.error).toContain('Refresh failed')
})
it('drops a late connection without chaining discovery after reset', async () => {
	const store = useEventGrid()
	let finish!: (v: unknown) => void
	connect.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.connect({
		profileId: crypto.randomUUID(),
		management: { resourceId: '/fixture', tenantId: 'fixture', clientId: crypto.randomUUID() },
	})
	store.reset()
	finish({ ok: true, value: { connectionId: crypto.randomUUID() } })
	await pending
	expect(store.connection).toBeUndefined()
	expect(list).not.toHaveBeenCalled()
})
it('keeps prior pages when a parent would exceed the tree display limit', async () => {
	const store = useEventGrid()
	store.topics = page(
		Array.from({ length: 1000 }, (_, i) => 'topic-' + i),
		crypto.randomUUID(),
	)
	list.mockResolvedValue({ ok: true, value: page(['overflow']) })
	await store.loadTopics(true)
	expect(store.topics.items).toHaveLength(1000)
	expect(store.error).toContain('display limit')
})
