import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useRelay } from '../../src/renderer/src/features/relay/stores/relay'
import type { DesktopResult } from '../../src/shared/contracts'
import type { RelayChange, RelayOutcome } from '../../src/shared/contracts/relay/core'
let pinia: Pinia
const change = vi.fn<(input: RelayChange) => Promise<DesktopResult<RelayOutcome>>>(),
	recover = vi.fn(),
	key = vi.fn(),
	get = vi.fn(),
	list = vi.fn(),
	importConfiguration = vi.fn(),
	applyConfiguration = vi.fn(),
	recoverConfiguration = vi.fn()
const setup: Omit<RelayChange, 'id' | 'connectionId'> = {
	target: { scope: { kind: 'namespace', name: '' }, policyName: 'sender' },
	action: 'create',
	expectedRevision: null,
	settings: null,
	rights: ['Send'],
	keyType: null,
	acknowledged: true,
}
const receipt = (id: string): RelayOutcome => ({
	operationId: id,
	target: setup.target,
	action: 'create',
	status: 'confirmed',
	summary: 'Created.',
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			importRelayConfiguration: importConfiguration,
			applyRelayConfiguration: applyConfiguration,
			getRelayConfigurationResult: recoverConfiguration,
			changeRelayResource: change,
			getRelayResult: recover,
			revealRelayKey: key,
			getRelayResource: get,
			listRelay: list,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useRelay().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		resourceId: 'fixture',
		connectedAt: new Date().toISOString(),
		location: 'westeurope',
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('requires review after an unavailable mutation response and retrieves the original receipt', async () => {
	const relay = useRelay()
	change.mockRejectedValue(new Error('IPC closed'))
	await relay.change(setup)
	const id = relay.outcome!.operationId
	expect(relay.blocked).toBe(true)
	await relay.change(setup)
	expect(change).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await relay.recover()
	expect(relay.blocked).toBe(true)
	expect(relay.error).toContain('does not prove')
	recover.mockResolvedValueOnce({ ok: true, value: receipt(id) })
	await relay.recover()
	expect(relay.blocked).toBe(false)
	expect(recover.mock.calls[0][0].operationId).toBe(id)
})
it('drops late write receipts and details after a connection reset', async () => {
	const relay = useRelay()
	let finish!: (value: DesktopResult<RelayOutcome>) => void
	change.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = relay.change(setup)
	const id = change.mock.calls[0][0].id
	relay.reset()
	finish({ ok: true, value: receipt(id) })
	await pending
	expect(relay.outcome).toBeUndefined()
	expect(relay.busy).toBe('')
})
it('does not continue a selection request into another connection after reset', async () => {
	const relay = useRelay()
	let finish!: (value: unknown) => void
	get.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = relay.select({ kind: 'hybrid', name: 'bridge' })
	relay.reset()
	finish({
		ok: true,
		value: {
			target: { scope: { kind: 'hybrid', name: 'bridge' }, policyName: null },
			revision: 'A'.repeat(64),
			properties: [],
			rights: null,
			settings: null,
			warning: null,
		},
	})
	await pending
	expect(list).not.toHaveBeenCalled()
	expect(relay.details).toBeUndefined()
})
it('keeps revealed keys out of retained state and operation logs', async () => {
	key.mockResolvedValue({
		ok: true,
		value: { key: 'SECRET-KEY', connectionString: 'SECRET-CONNECTION' },
	})
	const relay = useRelay()
	const value = await relay.run('Reveal Relay key', (id, connectionId) =>
		window.commander.revealRelayKey({
			id,
			connectionId,
			target: setup.target,
			keyType: 'PrimaryKey',
		}),
	)
	expect(value?.key).toBe('SECRET-KEY')
	expect(JSON.stringify(pinia.state.value)).not.toContain('SECRET-')
})
it('resets the uncertain-outcome review for every new write', async () => {
	change.mockImplementation(async (input) => ({
		ok: true,
		value: { ...receipt(input.id), status: 'unknown' },
	}))
	const relay = useRelay()
	await relay.change(setup)
	relay.reviewed = true
	expect(relay.blocked).toBe(false)
	await relay.change(setup)
	expect(relay.blocked).toBe(true)
	expect(relay.reviewed).toBe(false)
	expect(change).toHaveBeenCalledTimes(2)
})

it('uses cloneable import selections and blocks later mutations after an unavailable import response', async () => {
	const relay = useRelay()
	relay.configPreview = {
		importId: crypto.randomUUID(),
		sourceNamespace: 'source',
		destinationNamespace: 'fixture',
		expiresAt: new Date().toISOString(),
		entries: [],
		warnings: [],
	}
	applyConfiguration.mockImplementation(async (input) => {
		expect(structuredClone(input)).toEqual(input)
		throw new Error('IPC closed')
	})
	await relay.applyConfiguration([crypto.randomUUID()])
	expect(relay.configOutcome?.status).toBe('unknown')
	expect(relay.blocked).toBe(true)
	expect(relay.configPreview).toBeUndefined()
	await relay.change(setup)
	expect(change).not.toHaveBeenCalled()
	const id = relay.configOutcome!.operationId
	recoverConfiguration.mockResolvedValue({
		ok: true,
		value: { operationId: id, status: 'completed', summary: 'Recovered.', steps: [] },
	})
	await relay.recoverConfiguration()
	expect(recoverConfiguration.mock.calls[0][0].operationId).toBe(id)
	expect(relay.blocked).toBe(false)
})
it('drops a late configuration preview after a connection reset', async () => {
	const relay = useRelay()
	let finish!: (value: unknown) => void
	importConfiguration.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = relay.importConfiguration()
	relay.reset()
	finish({
		ok: true,
		value: {
			cancelled: false,
			fileName: 'late.json',
			preview: { importId: crypto.randomUUID() },
		},
	})
	await pending
	expect(relay.configPreview).toBeUndefined()
	expect(relay.configFileName).toBe('')
})
it('drops a late import receipt after a connection reset without refreshing the new connection', async () => {
	const relay = useRelay()
	relay.configPreview = {
		importId: crypto.randomUUID(),
		sourceNamespace: 'source',
		destinationNamespace: 'fixture',
		expiresAt: new Date().toISOString(),
		entries: [],
		warnings: [],
	}
	let finish!: (value: unknown) => void
	applyConfiguration.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = relay.applyConfiguration([crypto.randomUUID()])
	relay.reset()
	finish({
		ok: true,
		value: {
			operationId: crypto.randomUUID(),
			status: 'completed',
			summary: 'Created.',
			steps: [],
		},
	})
	await pending
	expect(relay.configOutcome).toBeUndefined()
	expect(list).not.toHaveBeenCalled()
})
