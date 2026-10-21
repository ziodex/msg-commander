import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { reactive } from 'vue'
import { useMessagingConfiguration } from '../../src/renderer/src/features/resource-configuration/stores/messaging-configuration'
import type { ConfigurationConnection } from '../../src/renderer/src/features/resource-configuration/model/connection'
import type { DesktopResult } from '../../src/shared/contracts'

let pinia: Pinia
const owner = (namespace: string) =>
	reactive({
		connection: { connectionId: crypto.randomUUID(), namespace },
		busy: '',
		error: '',
	}) satisfies ConfigurationConnection
beforeEach(() => {
	pinia = createPinia()
	setActivePinia(pinia)
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})

it('runs configuration against its explicit owner without creating another messaging store', async () => {
	const configs = useMessagingConfiguration(),
		bus = owner('bus'),
		hubs = owner('hubs')
	const action = vi.fn(
		async (id: string, connectionId: string): Promise<DesktopResult<string>> => {
			expect(connectionId).toBe(hubs.connection!.connectionId)
			expect(hubs.busy).toBe('Export')
			expect(bus.busy).toBe('')
			return { ok: true, value: id }
		},
	)
	expect(await configs.run('event-hubs', hubs, 'Export', action)).toBeTruthy()
	expect(hubs.busy).toBe('')
	expect([...pinia._s.keys()].sort()).toEqual(['messaging-configuration', 'workspace'])
})

it('discards a late response and leaves a replacement connection operation intact', async () => {
	const configs = useMessagingConfiguration(),
		connection = owner('bus')
	let finish!: (value: DesktopResult<string>) => void
	const pending = configs.run(
		'service-bus',
		connection,
		'Old import',
		() =>
			new Promise<DesktopResult<string>>((resolve) => {
				finish = resolve
			}),
	)
	connection.connection = { connectionId: crypto.randomUUID(), namespace: 'replacement' }
	connection.busy = 'New operation'
	connection.error = 'New error'
	// This also covers replacement while the configuration dialog is unmounted.
	finish({ ok: true, value: 'stale result' })
	expect(await pending).toBeUndefined()
	expect(connection.busy).toBe('New operation')
	expect(connection.error).toBe('New error')
})

it('clears receipts on connection replacement without clearing another service', () => {
	const configs = useMessagingConfiguration(),
		bus = owner('bus'),
		hubs = owner('hubs')
	configs.syncConnection('service-bus', bus.connection?.connectionId)
	configs.syncConnection('event-hubs', hubs.connection?.connectionId)
	configs.states['service-bus'].interrupted = true
	configs.states['event-hubs'].interrupted = true
	configs.syncConnection('service-bus', crypto.randomUUID())
	expect(configs.states['service-bus'].interrupted).toBe(false)
	expect(configs.states['event-hubs'].interrupted).toBe(true)
})
