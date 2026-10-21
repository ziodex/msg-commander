import { receiveServiceBusProgress } from '../../src/renderer/src/features/service-bus/operation-progress'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useWorkspace } from '../../src/renderer/src/shared/workspace/store'
import type { TestJobProgress } from '../../src/shared/contracts/service-bus/test-jobs'
let pinia: Pinia
beforeEach(() => {
	pinia = createPinia()
	setActivePinia(pinia)
	vi.stubGlobal('window', {})
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
function progress(operationId: string): TestJobProgress {
	return {
		type: 'test-job-progress',
		operationId,
		mode: 'receive',
		settlement: 'defer',
		maxMessages: 5,
		workers: 2,
		batchSize: 2,
		activeWorkers: 2,
		sent: 0,
		received: 3,
		completed: 0,
		settled: 3,
		abandoned: 0,
		deferred: 3,
		deadLettered: 0,
		redelivered: 0,
		uncertain: 0,
		sendBatches: 0,
		receiveCalls: 2,
		elapsedMs: 100,
		phase: 'settling',
	}
}
for (const failure of ['response', 'exception'] as const)
	it(`retains every confirmed settlement when a test job loses its ${failure}`, async () => {
		const store = useWorkspace()
		await expect(
			store.perform('Defer test', async (id) => {
				receiveServiceBusProgress(store.jobs, progress(id))
				if (failure === 'exception') throw new Error('Pipe closed')
				return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'Backend stopped' } }
			}),
		).rejects.toThrow()
		expect(store.jobs[0].status).toBe('failed')
		expect(store.jobs[0].message).toContain('3 defer settlements confirmed so far')
		expect(store.jobs[0].message).toContain('Final counts are unknown')
	})
it('uses acknowledged settlements in terminal progress rather than completion-only counts', async () => {
	const store = useWorkspace()
	await store.perform('Defer test', async (id) => {
		receiveServiceBusProgress(store.jobs, progress(id))
		return { ok: true, value: null }
	})
	expect(store.jobs[0].percent).toBe(60)
})
