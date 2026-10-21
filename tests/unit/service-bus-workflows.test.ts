import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useServiceBus } from '../../src/renderer/src/features/service-bus/stores/service-bus'
import type { NamespaceConnection, PeekPage } from '../../src/shared/service-bus'
import type { DesktopResult } from '../../src/shared/contracts'

let pinia: Pinia
const connect = vi.fn(),
	list = vi.fn(),
	peek = vi.fn()
const connection = (): NamespaceConnection => ({
	connectionId: crypto.randomUUID(),
	profileId: crypto.randomUUID(),
	namespace: 'fixture.servicebus.windows.net',
	connectedAt: new Date().toISOString(),
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: { connectNamespace: connect, listEntities: list, peekMessages: peek },
	})
	pinia = createPinia()
	setActivePinia(pinia)
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})

it('does not discover entities after a reset invalidates a pending connection', async () => {
	const sb = useServiceBus()
	let finish!: (value: DesktopResult<NamespaceConnection>) => void
	connect.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve
		}),
	)
	const pending = sb.connect(crypto.randomUUID())
	sb.reset()
	finish({ ok: true, value: connection() })
	await pending
	expect(sb.connection).toBeUndefined()
	expect(sb.busy).toBe('')
	expect(list).not.toHaveBeenCalled()
})

it('a late read cannot change a new generation or release its busy guard', async () => {
	const sb = useServiceBus()
	const select = () => {
		sb.connection = connection()
		sb.selected = {
			target: { kind: 'queue', name: 'orders' },
			status: 'Active',
			requiresSession: false,
		}
	}
	const finishes: ((value: DesktopResult<PeekPage>) => void)[] = []
	peek.mockImplementation(
		() =>
			new Promise((resolve) => {
				finishes.push(resolve)
			}),
	)
	select()
	const previous = sb.peek()
	sb.reset()
	select()
	const current = sb.peek()
	finishes[0]({
		ok: true,
		value: {
			items: [],
			nextSequenceNumber: '1',
			warning: null,
			fetchedAt: new Date().toISOString(),
		},
	})
	await previous
	expect(sb.messages).toBeUndefined()
	expect(sb.busy).toBe('Peek messages')
	finishes[1]({
		ok: true,
		value: {
			items: [],
			nextSequenceNumber: '2',
			warning: null,
			fetchedAt: new Date().toISOString(),
		},
	})
	await current
	expect(sb.messages?.nextSequenceNumber).toBe('2')
	expect(sb.busy).toBe('')
})
