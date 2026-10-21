import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useHybrid } from '../../src/renderer/src/features/relay/stores/hybrid'
import type { HybridRun, HybridResult } from '../../src/shared/contracts/relay/hybrid'
let pinia: Pinia
const run = vi.fn(),
	recover = vi.fn()
const setup: Omit<HybridRun, 'id'> = {
	profileId: crypto.randomUUID(),
	name: 'bridge',
	mode: 'http-send',
	method: 'POST',
	body: 'payload',
	encoding: 'utf8',
	headers: [],
	responseStatus: 200,
	maxCount: 1,
	maxSeconds: 60,
	exchangeSeconds: 10,
	acknowledged: true,
}
const result = (id: string): HybridResult => ({
	operationId: id,
	profileId: setup.profileId,
	namespace: 'fixture.servicebus.windows.net',
	name: 'bridge',
	mode: 'http-send',
	status: 'completed',
	reason: 'count',
	exchanges: [],
	elapsedMs: 10,
	summary: 'done',
	cleanupWarning: null,
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', { commander: { runHybrid: run, getHybridResult: recover } })
	pinia = createPinia()
	setActivePinia(pinia)
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('keeps uncertain results blocked until review or successful recovery', async () => {
	const store = useHybrid()
	run.mockResolvedValue({ ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'interrupted' } })
	await store.run(setup)
	expect(store.blocked('send')).toBe(true)
	await store.run(setup)
	expect(run).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await store.recover(store.entries[0])
	expect(store.blocked('send')).toBe(true)
	recover.mockResolvedValueOnce({ ok: true, value: result(store.entries[0].id) })
	await store.recover(store.entries[0])
	expect(store.blocked('send')).toBe(false)
})
it('keeps a listener independent of send state and ignores late results after reset', async () => {
	const store = useHybrid()
	let finish!: (value: unknown) => void
	run.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.run({ ...setup, mode: 'http-listen' })
	expect(store.blocked('listen')).toBe(true)
	expect(store.blocked('send')).toBe(false)
	const id = store.entries[0].id
	store.receive({
		type: 'hybrid-progress',
		operationId: id,
		count: 0,
		maxCount: 1,
		phase: 'online',
		elapsedMs: 20,
	})
	expect(store.entries[0].progress?.phase).toBe('online')
	store.reset()
	finish({ ok: true, value: result(id) })
	await pending
	expect(store.entries).toEqual([])
})
it('does not clear cleanup warnings by reviewing an unknown result', async () => {
	const store = useHybrid()
	run.mockImplementation((r: HybridRun) =>
		Promise.resolve({
			ok: true,
			value: { ...result(r.id), status: 'unknown', cleanupWarning: 'Restart backend.' },
		}),
	)
	await store.run(setup)
	store.entries[0].reviewed = true
	expect(store.blocked('send')).toBe(true)
	expect(store.blocked('listen')).toBe(true)
})

it('passes a structured-cloneable snapshot through Electron IPC', async () => {
	run.mockImplementation((request: HybridRun) => {
		const snapshot = structuredClone(request)
		return Promise.resolve({ ok: true, value: result(snapshot.id) })
	})
	const store = useHybrid()
	await store.run(setup)
	expect(store.entries[0].result?.status).toBe('completed')
	expect(store.entries[0].interrupted).toBe(false)
})
