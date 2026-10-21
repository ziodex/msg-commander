import { receiveEventGridProgress } from '../../src/renderer/src/features/event-grid/operation-progress'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useEventGrid } from '../../src/renderer/src/features/event-grid/stores/event-grid'
import { useWorkspace } from '../../src/renderer/src/shared/workspace/store'
import {
	newCloudEvent,
	type EventGridPublishOutcome,
} from '../../src/shared/contracts/event-grid/publishing'
const publish = vi.fn(),
	recover = vi.fn(),
	list = vi.fn()
let pinia: Pinia
const setup = () => ({
	topicName: 'orders',
	mode: 'single' as const,
	drafts: [newCloudEvent()],
	batchSize: 25,
	maxSeconds: 60,
	delayMs: 0,
	acknowledged: true as const,
})
const receipt = (
	status: EventGridPublishOutcome['status'] = 'completed',
): EventGridPublishOutcome => ({
	operationId: crypto.randomUUID(),
	topicName: 'orders',
	totalEvents: 1,
	confirmed: status === 'completed' ? 1 : 0,
	confirmedBatches: status === 'completed' ? 1 : 0,
	uncertain: status === 'unknown' ? 1 : 0,
	elapsedMs: 10,
	status,
	reason: status === 'completed' ? 'count' : 'error',
	lastBatchFirstIndex: 1,
	lastBatchCount: 1,
	summary: 'Publish ' + status,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			publishEventGrid: publish,
			getEventGridPublishResult: recover,
			listEventGrid: list,
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
it('clones publish drafts for IPC and reports confirmed job results', async () => {
	const store = useEventGrid(),
		value = receipt()
	publish.mockResolvedValue({ ok: true, value })
	await store.publish(setup())
	expect(structuredClone(publish.mock.calls[0][0]).drafts).toHaveLength(1)
	expect(store.publishOutcome).toEqual(value)
	expect(useWorkspace().jobs[0].status).toBe('completed')
})
it('blocks further writes on missing IPC responses and keeps read-only receipt recovery available', async () => {
	const store = useEventGrid()
	publish.mockRejectedValue(new Error('IPC lost'))
	await store.publish(setup())
	expect(store.publishOutcome?.status).toBe('unknown')
	expect(store.writeBlocked).toBe(true)
	expect(useWorkspace().jobs[0].status).toBe('unknown')
	await store.publish(setup())
	expect(publish).toHaveBeenCalledTimes(1)
	const value = receipt()
	recover.mockResolvedValue({ ok: true, value })
	await store.recoverPublish()
	expect(store.publishOutcome).toEqual(value)
	expect(store.writeBlocked).toBe(false)
})
it('allows explicit review after uncertainty and treats a missing retained receipt as inconclusive', async () => {
	const store = useEventGrid()
	store.publishOutcome = receipt('unknown')
	recover.mockResolvedValue({ ok: true, value: null })
	await store.recoverPublish()
	expect(store.error).toContain('does not prove failure')
	expect(store.writeBlocked).toBe(true)
	store.publishReviewed = true
	expect(store.writeBlocked).toBe(false)
	publish.mockResolvedValue({ ok: true, value: receipt('failed') })
	await store.publish(setup())
	expect(useWorkspace().jobs[0].status).toBe('failed')
})
it('retains cancellation receipts and ignores late results from an expired connection generation', async () => {
	const store = useEventGrid()
	publish.mockResolvedValue({ ok: true, value: receipt('cancelled') })
	await store.publish(setup())
	expect(useWorkspace().jobs[0].status).toBe('cancelled')
	let finish!: (v: unknown) => void
	publish.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve
		}),
	)
	const pending = store.publish(setup())
	store.reset()
	finish({ ok: true, value: receipt() })
	await pending
	expect(store.publishOutcome).toBeUndefined()
	expect(store.connection).toBeUndefined()
})
it('keeps progress counts and partial percentages after cancellation and ignores late progress', async () => {
	const workspace = useWorkspace()
	const pending = workspace.perform(
		'Publish test',
		async (id) => {
			receiveEventGridProgress(workspace.jobs, {
				type: 'event-grid-publish-progress',
				operationId: id,
				totalEvents: 4,
				confirmed: 1,
				confirmedBatches: 1,
				uncertain: 0,
				elapsedMs: 100,
				phase: 'pacing',
			})
			expect(workspace.jobs[0].message).toContain('1/4 events confirmed')
			return { ok: true, value: receipt('cancelled') }
		},
		(value) => ({
			status: value.status === 'limited' ? 'completed' : value.status,
			message: value.summary,
		}),
	)
	await pending
	expect(workspace.jobs[0].percent).toBe(25)
	receiveEventGridProgress(workspace.jobs, {
		type: 'event-grid-publish-progress',
		operationId: workspace.jobs[0].id,
		totalEvents: 4,
		confirmed: 4,
		confirmedBatches: 4,
		uncertain: 0,
		elapsedMs: 200,
		phase: 'finished',
	})
	expect(workspace.jobs[0].percent).toBe(25)
})
