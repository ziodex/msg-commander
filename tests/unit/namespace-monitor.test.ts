import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import {
	totalCounts,
	countText,
	entityKey,
} from '../../src/renderer/src/features/service-bus/lib/entity-counts'
import { useNamespaceMonitor } from '../../src/renderer/src/features/service-bus/stores/namespace-monitor'
import { useServiceBus } from '../../src/renderer/src/features/service-bus/stores/service-bus'
import { useWorkspace } from '../../src/renderer/src/shared/workspace/store'
import type { ListRequest, RuntimeEntity, RuntimePage } from '../../src/shared/service-bus'
import type { DesktopResult } from '../../src/shared/contracts'
let pinia: Pinia
let monitor: ReturnType<typeof useNamespaceMonitor>
const row = (
	kind: 'queue' | 'topic' | 'subscription',
	name: string,
	active: string,
	deadLetter = '1',
	scheduled = '2',
): RuntimeEntity => ({
	target: kind === 'subscription' ? { kind, name, topicName: 'events' } : { kind, name },
	counts: {
		active: kind === 'topic' ? null : active,
		deadLetter: kind === 'topic' ? null : deadLetter,
		scheduled: kind === 'subscription' ? null : scheduled,
		transfer: kind === 'topic' ? null : '0',
		transferDeadLetter: kind === 'topic' ? null : '0',
		total:
			kind === 'topic'
				? null
				: (
						BigInt(active) +
						BigInt(deadLetter) +
						(kind === 'queue' ? BigInt(scheduled) : 0n)
					).toString(),
		sizeBytes: null,
	},
})
const success = (
	items: RuntimeEntity[],
	continuationToken: string | null = null,
): DesktopResult<RuntimePage> => ({
	ok: true,
	value: { items, continuationToken, fetchedAt: new Date().toISOString() },
})
const feed = vi.fn<(input: ListRequest) => Promise<DesktopResult<RuntimePage>>>()
const cancel = vi.fn().mockResolvedValue({ ok: true, value: null })
function connect(id = '879c05a7-0818-483a-8074-b2c126ad79c5') {
	useServiceBus().connection = {
		connectionId: id,
		profileId: '9f8c94ef-571d-4848-bb0c-7208f86c6649',
		namespace: 'fixture.servicebus.windows.net',
		connectedAt: new Date().toISOString(),
	}
}
beforeEach(() => {
	vi.useFakeTimers()
	vi.clearAllMocks()
	vi.stubGlobal('window', { commander: { listRuntimeCounts: feed, cancelOperation: cancel } })
	vi.stubGlobal('document', {
		hidden: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	})
	vi.stubGlobal('localStorage', { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() })
	pinia = createPinia()
	setActivePinia(pinia)
	connect()
	monitor = useNamespaceMonitor()
	feed.mockImplementation(async (input) =>
		input.kind === 'queue'
			? input.continuationToken
				? success([row('queue', 'archive', '7')])
				: success([row('queue', 'orders', '9007199254740993')], 'second')
			: input.kind === 'topic'
				? success([row('topic', 'events', '0', '0', '5')])
				: success([row('subscription', 'billing', '3')]),
	)
})
afterEach(() => {
	monitor.stop()
	disposePinia(pinia)
	vi.useRealTimers()
	vi.unstubAllGlobals()
})
it('sums exact integers and counts scheduled topic messages once, separately from subscription copies', () => {
	const totals = totalCounts(
		[
			row('queue', 'q', '9007199254740993'),
			row('topic', 'events', '0', '0', '5'),
			row('subscription', 'billing', '3'),
		],
		true,
	)
	expect(totals.active).toEqual({ value: '9007199254740996', partial: false })
	expect(totals.scheduled.value).toBe('7')
	expect(totals.deadLetter.value).toBe('2')
	expect(totals.total.value).toBe('9007199254741005')
	expect(countText('9007199254740993').replace(/[^0-9]/g, '')).toBe('9007199254740993')
	expect(countText(null)).toBe('—')
	expect(totalCounts([], false).active.value).toBe(null)
	expect(totalCounts([], true).active.value).toBe('0')
})
it('refreshes every page and collapsed topic subscription, without touching selection or logging background jobs', async () => {
	const sb = useServiceBus()
	sb.selected = {
		target: { kind: 'queue', name: 'orders' },
		status: 'Active',
		requiresSession: false,
	}
	sb.fromSequence = '42'
	monitor.start()
	await vi.advanceTimersByTimeAsync(0)
	expect(feed).toHaveBeenCalledTimes(4)
	expect(monitor.rows).toHaveLength(4)
	expect(monitor.complete).toBe(true)
	expect(monitor.totals.active.value).toBe('9007199254741003')
	expect(sb.selected.target.name).toBe('orders')
	expect(sb.fromSequence).toBe('42')
	expect(monitor.counts({ kind: 'queue', name: 'ORDERS' })?.active).toBe('9007199254740993')
	await vi.advanceTimersByTimeAsync(30000)
	expect(feed).toHaveBeenCalledTimes(8)
})
it('marks partial scans honestly and treats missing counts as unavailable rather than zero', async () => {
	feed.mockImplementation(async (input) =>
		input.kind === 'subscription'
			? { ok: false, error: { code: 'DENIED', message: 'not exposed by the monitor' } }
			: success([row(input.kind, input.kind === 'topic' ? 'events' : 'orders', '8')]),
	)
	monitor.start()
	await vi.advanceTimersByTimeAsync(0)
	expect(monitor.complete).toBe(false)
	expect(monitor.issues[0]).toContain('counts unavailable')
	expect(monitor.totals.active).toEqual({ value: '8', partial: true })
	const missing = row('queue', 'x', '1')
	missing.counts.deadLetter = null
	expect(totalCounts([missing], true).deadLetter).toEqual({ value: null, partial: true })
})
it('pauses polling, preserves manual refresh and skips busy or hidden workspaces', async () => {
	monitor.start()
	await vi.advanceTimersByTimeAsync(0)
	monitor.interval = 0
	await nextTick()
	await vi.advanceTimersByTimeAsync(60000)
	expect(feed).toHaveBeenCalledTimes(4)
	await monitor.refresh()
	expect(feed).toHaveBeenCalledTimes(8)
	useServiceBus().busy = 'Sending'
	await monitor.refresh()
	expect(feed).toHaveBeenCalledTimes(8)
	useServiceBus().busy = ''
	Object.defineProperty(document, 'hidden', { value: true, configurable: true })
	await monitor.refresh()
	expect(feed).toHaveBeenCalledTimes(8)
})
it('applies imported custom intervals and disables automatic counts while retaining manual refresh', async () => {
	const workspace = useWorkspace()
	workspace.acceptPreferences({
		...workspace.preferenceState,
		preferences: {
			...workspace.preferences,
			showMessageCounts: false,
			countRefreshSeconds: 45,
		},
	})
	await nextTick()
	monitor.start()
	await vi.advanceTimersByTimeAsync(90000)
	expect(monitor.interval).toBe(45)
	expect(feed).not.toHaveBeenCalled()
	await monitor.refresh()
	expect(feed).toHaveBeenCalledTimes(4)
	await vi.advanceTimersByTimeAsync(90000)
	expect(feed).toHaveBeenCalledTimes(4)
	workspace.acceptPreferences({
		...workspace.preferenceState,
		preferences: { ...workspace.preferences, showMessageCounts: true },
	})
	await vi.advanceTimersByTimeAsync(0)
	expect(feed).toHaveBeenCalledTimes(8)
	await vi.advanceTimersByTimeAsync(45000)
	expect(feed).toHaveBeenCalledTimes(12)
})
it('cancels a pending count read when foreground work starts, and ignores the late result', async () => {
	let resolve!: (value: DesktopResult<RuntimePage>) => void
	feed.mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	monitor.start()
	await vi.advanceTimersByTimeAsync(90000)
	expect(feed).toHaveBeenCalledTimes(1) // No overlapping polling while one feed is pending.
	useServiceBus().busy = 'Inspect message'
	expect(cancel).toHaveBeenCalledWith(feed.mock.calls[0][0].id)
	resolve(success([row('queue', 'late', '777')]))
	await vi.advanceTimersByTimeAsync(0)
	expect(monitor.rows).toEqual([])
	expect(monitor.updatedAt).toBe('')
})
it('invalidates old-connection responses and retains prior counts when pagination repeats', async () => {
	monitor.start()
	await vi.advanceTimersByTimeAsync(0)
	const previous = monitor.rows.map((item) => entityKey(item.target))
	feed.mockImplementation(async () => success([row('queue', 'repeat', '1')], 'same'))
	await monitor.refresh()
	expect(monitor.rows.map((item) => entityKey(item.target))).toEqual(previous)
	expect(monitor.stale).toBe(true)
	expect(monitor.issues[0]).toContain('did not finish')
	let resolve!: (value: DesktopResult<RuntimePage>) => void
	feed.mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done
			}),
	)
	const pending = monitor.refresh()
	useServiceBus().reset()
	resolve(success([row('queue', 'old-namespace', '777')]))
	await pending
	expect(monitor.rows).toEqual([])
	expect(monitor.updatedAt).toBe('')
})
