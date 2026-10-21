import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEntityTree } from '../../src/renderer/src/features/service-bus/stores/entity-tree'
import { useServiceBus } from '../../src/renderer/src/features/service-bus/stores/service-bus'
import { entityKey } from '../../src/renderer/src/features/service-bus/lib/entity-counts'
import type { Entity, EntityPage, ListRequest } from '../../src/shared/service-bus'
import type { DesktopResult } from '../../src/shared/contracts'
let pinia: Pinia
let tree: ReturnType<typeof useEntityTree>
const feed = vi.fn<(request: ListRequest) => Promise<DesktopResult<EntityPage>>>()
const cancel = vi.fn().mockResolvedValue({ ok: true, value: null })
const entity = (
	kind: 'queue' | 'topic' | 'subscription',
	name: string,
	topicName = 'events',
): Entity => ({
	target: kind === 'subscription' ? { kind, name, topicName } : { kind, name },
	status: 'Active',
	requiresSession: false,
})
const page = (
	items: Entity[],
	continuationToken: string | null = null,
): DesktopResult<EntityPage> => ({ ok: true, value: { items, continuationToken } })
function connect(id = '879c05a7-0818-483a-8074-b2c126ad79c5') {
	useServiceBus().connection = {
		connectionId: id,
		profileId: '9f8c94ef-571d-4848-bb0c-7208f86c6649',
		namespace: 'fixture.servicebus.windows.net',
		connectedAt: new Date().toISOString(),
	}
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('window', { commander: { listEntities: feed, cancelOperation: cancel } })
	pinia = createPinia()
	setActivePinia(pinia)
	connect()
	tree = useEntityTree()
	tree.branch('queue').loaded = false
	feed.mockImplementation(async (request) =>
		request.kind === 'queue'
			? request.continuationToken
				? page([entity('queue', 'archive')])
				: page([entity('queue', 'orders')], 'second')
			: request.kind === 'topic'
				? page([entity('topic', 'events')])
				: request.continuationToken
					? page([entity('subscription', 'audit')])
					: page([entity('subscription', 'billing')], 'second'),
	)
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('expands every page and subscription without changing selection, and collapses without losing loaded data', async () => {
	const sb = useServiceBus()
	sb.selected = entity('queue', 'orders')
	await tree.expandAll()
	expect(feed).toHaveBeenCalledTimes(5)
	for (const e of [
		entity('queue', 'orders'),
		entity('queue', 'archive'),
		entity('topic', 'events'),
		entity('subscription', 'billing'),
		entity('subscription', 'audit'),
	])
		expect(tree.expanded[entityKey(e.target)]).toBe(true)
	expect(sb.selected.target.name).toBe('orders')
	expect(sb.category).toBe('queue')
	tree.collapseAll()
	expect(tree.expanded).toEqual({ queue: false, topic: false })
	expect(tree.branch('subscription', 'events').items).toHaveLength(2)
	await tree.expandAll()
	expect(feed).toHaveBeenCalledTimes(5)
})
it('collapse, foreground work and disconnect stop expansion and ignore late pages', async () => {
	let resolve!: (value: DesktopResult<EntityPage>) => void
	feed.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	const run = tree.expandAll()
	const pendingId = feed.mock.calls[0][0].id
	tree.collapseAll()
	expect(cancel).toHaveBeenCalledWith(pendingId)
	resolve(page([entity('queue', 'late')]))
	await run
	expect(tree.expanded).toEqual({ queue: false, topic: false })
	expect(tree.branch('queue').items).toEqual([])
	const second = tree.expandAll()
	useServiceBus().busy = 'Receive messages'
	expect(tree.expandingAll).toBe(false)
	expect(tree.expansionError).toContain('paused')
	resolve(page([entity('queue', 'late')]))
	await second
	expect(tree.branch('queue').items).toEqual([])
	useServiceBus().busy = ''
	const third = tree.expandAll()
	connect('01111111-1111-4111-8111-111111111111')
	resolve(page([entity('queue', 'other-namespace')]))
	await third
	expect(tree.branch('queue').items).toEqual([])
	expect(tree.expandingAll).toBe(false)
})
it('stops repeated continuation tokens without retry loops and permits explicit retry', async () => {
	feed.mockResolvedValue(page([entity('queue', 'orders')], 'same'))
	await tree.expandAll()
	expect(feed).toHaveBeenCalledTimes(2)
	expect(tree.expandingAll).toBe(false)
	expect(tree.expansionError).toContain('Some branches')
	expect(tree.branch('queue').items).toHaveLength(1)
	feed.mockResolvedValue(page([]))
	await tree.expandAll()
	expect(tree.expansionError).toBe('')
})
it('selects a complete folder across pages with exact path boundaries, ignoring filters and preserving individual selection', async () => {
	tree.toggleChecked(entity('subscription', 'billing').target)
	tree.filter = 'hidden'
	feed.mockImplementation(async (request) =>
		request.continuationToken
			? page([entity('queue', 'team/nested/b'), entity('queue', 'teamwork/c')])
			: page([entity('queue', 'team/a'), entity('queue', 'team')], 'next'),
	)
	await tree.selectScope('queue', 'team')
	expect(tree.selectedTargets.map((target) => target.name)).toEqual([
		'billing',
		'team/a',
		'team/nested/b',
	])
	expect(feed).toHaveBeenCalledTimes(2)
	tree.collapseAll()
	expect(tree.selectedTargets).toHaveLength(3)
})
it('scope selection is atomic on page failures, overflow and repeated cursors', async () => {
	const original = entity('queue', 'orders').target
	tree.toggleChecked(original)
	feed.mockResolvedValueOnce(page([entity('queue', 'archive')], 'more')).mockResolvedValueOnce({
		ok: false,
		error: { code: 'DENIED', message: 'Could not load.' },
	})
	await tree.selectScope('queue')
	expect(tree.selectedTargets).toEqual([original])
	expect(tree.selectionError).toContain('Could not load')
	feed.mockResolvedValue(page(Array.from({ length: 101 }, (_, i) => entity('queue', `q${i}`))))
	await tree.selectScope('queue')
	expect(tree.selectedTargets).toEqual([original])
	expect(tree.selectionError).toContain('100 selected')
	feed.mockResolvedValue(page([entity('queue', 'archive')], 'same'))
	await tree.selectScope('queue')
	expect(tree.selectedTargets).toEqual([original])
	expect(tree.selectionError).toContain('Paging')
})
it('cancellation, foreground work and connection changes fence late selection responses', async () => {
	let resolve!: (value: DesktopResult<EntityPage>) => void
	feed.mockImplementation(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	for (const stop of [
		() => tree.cancelSelection(),
		() => {
			useServiceBus().busy = 'Edit entity'
		},
		() => connect('01111111-1111-4111-8111-111111111111'),
	]) {
		useServiceBus().busy = ''
		const pending = tree.selectScope('queue')
		stop()
		resolve(page([entity('queue', 'late')]))
		await pending
		expect(tree.selectedTargets).toEqual([])
		expect(tree.selectionBusy).toBe(false)
	}
	expect(cancel).toHaveBeenCalledTimes(3)
})

it('refreshes only the clicked entity, updates counts and status, and preserves selection and inspection', async () => {
	const { useNamespaceMonitor } =
		await import('../../src/renderer/src/features/service-bus/stores/namespace-monitor')
	const sb = useServiceBus()
	const counts = {
		active: '7',
		deadLetter: '3',
		scheduled: '0',
		transfer: '0',
		transferDeadLetter: '0',
		total: '10',
		sizeBytes: '123',
	}
	const getEntity = vi.fn().mockImplementation(async ({ target }) => ({
		ok: true,
		value: {
			entity: { target, status: 'Disabled', requiresSession: false },
			counts,
			properties: [],
			fetchedAt: new Date().toISOString(),
			countsWarning: null,
		},
	}))
	Object.assign(window.commander, { getEntity })
	await tree.load('topic')
	await tree.load('subscription', 'events')
	sb.selected = entity('queue', 'orders')
	sb.fromSequence = '9007199254740993'
	sb.selectionView = 'messages'
	const selection = sb.selected
	await tree.refreshEntity({ kind: 'topic', name: 'events' })
	expect(getEntity).toHaveBeenLastCalledWith(
		expect.objectContaining({ target: { kind: 'topic', name: 'events' } }),
	)
	expect(tree.branch('topic').items[0].status).toBe('Disabled')
	expect(feed).toHaveBeenLastCalledWith(
		expect.objectContaining({ kind: 'subscription', topicName: 'events' }),
	)
	expect(useNamespaceMonitor().counts({ kind: 'topic', name: 'events' })).toEqual(counts)
	expect(sb.selected).toBe(selection)
	expect(sb.fromSequence).toBe('9007199254740993')
	expect(sb.selectionView).toBe('messages')
	sb.selected = entity('subscription', 'billing')
	const current = sb.selected
	await tree.refreshEntity(current.target)
	expect(sb.selected).toBe(current)
	expect(sb.selected.status).toBe('Disabled')
	expect(sb.details?.counts).toEqual(counts)
	getEntity.mockResolvedValueOnce({
		ok: false,
		error: { code: 'failed', message: 'Unavailable' },
	})
	await tree.refreshEntity(current.target)
	expect(sb.error).toBe('Unavailable')
	expect(sb.details?.counts).toEqual(counts)
})
it('does not apply a late entity refresh after reconnecting', async () => {
	const sb = useServiceBus()
	let resolve!: (value: unknown) => void
	Object.assign(window.commander, {
		getEntity: () =>
			new Promise((done) => {
				resolve = done
			}),
	})
	const run = tree.refreshEntity({ kind: 'queue', name: 'orders' })
	sb.reset()
	connect('979c05a7-0818-483a-8074-b2c126ad79c5')
	resolve({ ok: true, value: { entity: entity('queue', 'old') } })
	await run
	expect(tree.branch('queue').items).toEqual([])
	expect(sb.details).toBeUndefined()
})
