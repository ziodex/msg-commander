import { receiveEventGridProgress } from '../../src/renderer/src/features/event-grid/operation-progress'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventGrid } from '../../src/renderer/src/features/event-grid/stores/event-grid'
import { useWorkspace } from '../../src/renderer/src/shared/workspace/store'
import type { EventGridPullOutcome } from '../../src/shared/contracts/event-grid/pulling'
const receive = vi.fn(),
	settle = vi.fn(),
	recover = vi.fn(),
	list = vi.fn(),
	inspect = vi.fn()
const target = {
	kind: 'subscription',
	topicName: 'orders',
	subscriptionName: 'fulfillment',
} as const
let pinia: Pinia
const setup = () => ({
	target,
	maxEvents: 3,
	batchSize: 2,
	maxWaitSeconds: 10,
	maxSeconds: 60,
	acknowledged: true as const,
})
const receipt = (status: EventGridPullOutcome['status'] = 'completed'): EventGridPullOutcome => ({
	operationId: crypto.randomUUID(),
	target,
	action: 'receive',
	requested: 3,
	confirmed: status === 'completed' ? 3 : 0,
	failed: 0,
	uncertain: status === 'unknown' ? 2 : 0,
	elapsedMs: 10,
	status,
	reason: 'count',
	summary: 'Pull ' + status,
	handles: [],
	results: [],
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			receiveEventGrid: receive,
			settleEventGrid: settle,
			getEventGridPullResult: recover,
			listReceivedEventGrid: list,
			inspectReceivedEventGrid: inspect,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	list.mockResolvedValue({ ok: true, value: [] })
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
it('clones receive and settlement inputs and retains job receipts', async () => {
	const store = useEventGrid(),
		value = receipt()
	receive.mockResolvedValue({ ok: true, value })
	await store.receive(setup())
	expect(structuredClone(receive.mock.calls[0][0]).target).toEqual(target)
	expect(store.pullOutcome).toEqual(value)
	expect(useWorkspace().jobs[1].status).toBe('completed')
	settle.mockResolvedValue({ ok: true, value: { ...value, action: 'release' } })
	const handles = [crypto.randomUUID()]
	await store.settle({
		target,
		handles,
		action: 'release',
		releaseDelaySeconds: 60,
		acknowledged: true,
	})
	expect(structuredClone(settle.mock.calls[0][0]).handles).toEqual(handles)
})
it('blocks additional writes after missing IPC and recovers receipts without replaying operations', async () => {
	const store = useEventGrid()
	receive.mockRejectedValue(new Error('lost IPC'))
	await store.receive(setup())
	expect(store.pullOutcome?.status).toBe('unknown')
	expect(store.writeBlocked).toBe(true)
	expect(store.pullOutcome?.summary).toContain('unverified')
	await store.receive(setup())
	expect(receive).toHaveBeenCalledTimes(1)
	recover.mockResolvedValue({ ok: true, value: receipt() })
	await store.recoverPull()
	expect(store.writeBlocked).toBe(false)
	expect(receive).toHaveBeenCalledTimes(1)
	expect(list).toHaveBeenCalledTimes(2)
})
it('preserves unknown evidence when recovery is unavailable and permits explicit review', async () => {
	const store = useEventGrid()
	store.pullOutcome = receipt('unknown')
	recover.mockResolvedValue({ ok: true, value: null })
	await store.recoverPull()
	expect(store.pullOutcome.status).toBe('unknown')
	expect(store.error).toContain('Missing evidence')
	expect(store.writeBlocked).toBe(true)
	store.pullReviewed = true
	expect(store.writeBlocked).toBe(false)
})
it('ignores late receive results after a connection generation reset', async () => {
	let finish!: (v: unknown) => void
	receive.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const store = useEventGrid(),
		pending = store.receive(setup())
	store.reset()
	finish({ ok: true, value: receipt() })
	await pending
	expect(store.pullOutcome).toBeUndefined()
	expect(store.received).toEqual({})
	expect(list).not.toHaveBeenCalled()
})
it('preserves partial progress percentages and ignores finished-job updates', async () => {
	const workspace = useWorkspace()
	const value = receipt('cancelled')
	receive.mockImplementation(async (p) => {
		receiveEventGridProgress(workspace.jobs, {
			type: 'event-grid-pull-progress',
			operationId: p.id,
			action: 'receive',
			requested: 3,
			confirmed: 1,
			failed: 0,
			uncertain: 0,
			elapsedMs: 1,
			phase: 'finished',
		})
		return { ok: true, value }
	})
	await useEventGrid().receive(setup())
	const job = workspace.jobs.find((j) => j.label === 'Event Grid: receive')!
	expect(job.status).toBe('cancelled')
	expect(job.percent).toBeCloseTo(100 / 3)
	receiveEventGridProgress(workspace.jobs, {
		type: 'event-grid-pull-progress',
		operationId: job.id,
		action: 'receive',
		requested: 3,
		confirmed: 3,
		failed: 0,
		uncertain: 0,
		elapsedMs: 2,
		phase: 'finished',
	})
	expect(job.percent).toBeCloseTo(100 / 3)
})
