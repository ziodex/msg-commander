import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useNotificationHubs } from '../../src/renderer/src/features/notification-hubs/stores/notification-hubs'
import type { DesktopResult } from '../../src/shared/contracts'
import type {
	NotificationHubChange,
	NotificationHubOutcome,
} from '../../src/shared/contracts/notification-hubs/core'
let pinia: Pinia
const change =
		vi.fn<(input: NotificationHubChange) => Promise<DesktopResult<NotificationHubOutcome>>>(),
	recover = vi.fn(),
	key = vi.fn(),
	get = vi.fn(),
	list = vi.fn()
const setup: Omit<NotificationHubChange, 'id' | 'connectionId'> = {
	target: { scope: { kind: 'namespace', name: '' }, policyName: 'sender' },
	action: 'create',
	expectedRevision: null,
	settings: null,
	rights: ['Send'],
	keyType: null,
	acknowledged: true,
}
const receipt = (id: string): NotificationHubOutcome => ({
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
			changeNotificationHubResource: change,
			getNotificationHubResult: recover,
			revealNotificationHubKey: key,
			getNotificationHubResource: get,
			listNotificationHub: list,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useNotificationHubs().connection = {
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
	const nh = useNotificationHubs()
	change.mockRejectedValue(new Error('IPC closed'))
	await nh.change(setup)
	const id = nh.outcome!.operationId
	expect(nh.blocked).toBe(true)
	await nh.change(setup)
	expect(change).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await nh.recover()
	expect(nh.blocked).toBe(true)
	expect(nh.error).toContain('does not prove')
	recover.mockResolvedValueOnce({ ok: true, value: receipt(id) })
	await nh.recover()
	expect(nh.blocked).toBe(false)
	expect(recover.mock.calls[0][0].operationId).toBe(id)
})
it('drops late write receipts and details after a connection reset', async () => {
	const nh = useNotificationHubs()
	let finish!: (value: DesktopResult<NotificationHubOutcome>) => void
	change.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = nh.change(setup)
	const id = change.mock.calls[0][0].id
	nh.reset()
	finish({ ok: true, value: receipt(id) })
	await pending
	expect(nh.outcome).toBeUndefined()
	expect(nh.busy).toBe('')
})
it('does not continue a selection request into another connection after reset', async () => {
	const nh = useNotificationHubs()
	let finish!: (value: unknown) => void
	get.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = nh.select({ kind: 'hub', name: 'alerts' })
	nh.reset()
	finish({
		ok: true,
		value: {
			target: { scope: { kind: 'hub', name: 'alerts' }, policyName: null },
			revision: 'A'.repeat(64),
			properties: [],
			rights: null,
			settings: null,
			warning: null,
		},
	})
	await pending
	expect(list).not.toHaveBeenCalled()
	expect(nh.details).toBeUndefined()
})
it('keeps revealed keys out of retained state and operation logs', async () => {
	key.mockResolvedValue({
		ok: true,
		value: { key: 'SECRET-KEY', connectionString: 'SECRET-CONNECTION' },
	})
	const nh = useNotificationHubs()
	const value = await nh.run('Reveal NotificationHub key', (id, connectionId) =>
		window.commander.revealNotificationHubKey({
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
	const nh = useNotificationHubs()
	await nh.change(setup)
	nh.reviewed = true
	expect(nh.blocked).toBe(false)
	await nh.change(setup)
	expect(nh.blocked).toBe(true)
	expect(nh.reviewed).toBe(false)
	expect(change).toHaveBeenCalledTimes(2)
})

it('snapshots reactive nested tags before typed IPC', async () => {
	const nh = useNotificationHubs()
	const { reactive } = await import('vue')
	change.mockImplementation(async (input) => {
		expect(structuredClone(input)).toEqual(input)
		return { ok: true, value: receipt(input.id) }
	})
	await nh.change(
		reactive({
			...setup,
			target: { scope: { kind: 'hub', name: 'new-hub' }, policyName: null },
			rights: null,
			settings: {
				registrationTtl: '90.00:00:00',
				tags: [{ name: 'environment', value: 'test' }],
			},
		}),
	)
	expect(change).toHaveBeenCalledTimes(1)
})
it('routes provider writes through the dedicated IPC and blocks after lost acknowledgment', async () => {
	const nh = useNotificationHubs()
	const credential = vi.fn().mockRejectedValue(new Error('IPC closed'))
	window.commander.changeNotificationHubCredentials = credential
	const setup = {
		action: 'credentials' as const,
		target: { scope: { kind: 'hub' as const, name: 'alerts' }, policyName: null },
		expectedRevision: 'A'.repeat(64),
		draft: { provider: 'wns' as const, packageSid: 'PRIVATE-SID', secretKey: 'PRIVATE-SECRET' },
		acknowledged: true as const,
	}
	await nh.change(setup)
	expect(credential).toHaveBeenCalledTimes(1)
	expect(credential.mock.calls[0][0]).not.toHaveProperty('action')
	expect(nh.outcome?.action).toBe('credentials')
	expect(nh.outcome?.status).toBe('unknown')
	expect(JSON.stringify(nh.outcome)).not.toContain('PRIVATE')
	expect(nh.blocked).toBe(true)
	await nh.change(setup)
	expect(credential).toHaveBeenCalledTimes(1)
})
it('drops a late provider write receipt after connection reset', async () => {
	const nh = useNotificationHubs()
	let finish!: (value: DesktopResult<NotificationHubOutcome>) => void
	window.commander.changeNotificationHubCredentials = vi.fn(
		() =>
			new Promise<DesktopResult<NotificationHubOutcome>>((resolve) => {
				finish = resolve
			}),
	)
	const pending = nh.change({
		action: 'credentials',
		target: { scope: { kind: 'hub', name: 'alerts' }, policyName: null },
		expectedRevision: 'A'.repeat(64),
		draft: { provider: 'adm', clientId: 'PRIVATE-ID', clientSecret: 'PRIVATE-SECRET' },
		acknowledged: true,
	})
	await Promise.resolve()
	nh.reset()
	finish({ ok: true, value: { ...receipt(crypto.randomUUID()), action: 'credentials' } })
	await pending
	expect(nh.outcome).toBeUndefined()
	expect(nh.busy).toBe('')
})

const configPreview = () => ({
	importId: crypto.randomUUID(),
	sourceNamespace: 'source',
	destinationNamespace: 'fixture',
	expiresAt: new Date(Date.now() + 600000).toISOString(),
	entries: [],
	warnings: [],
})
it('blocks provider/admin writes after lost import acknowledgment and recovers only the retained receipt', async () => {
	const nh = useNotificationHubs()
	nh.configPreview = configPreview()
	const apply = vi.fn().mockRejectedValue(new Error('closed')),
		result = vi.fn().mockResolvedValue({ ok: true, value: null })
	window.commander.applyNotificationHubConfiguration = apply
	window.commander.getNotificationHubConfigurationResult = result
	await nh.applyConfiguration([crypto.randomUUID()])
	expect(nh.configOutcome?.status).toBe('unknown')
	expect(nh.blocked).toBe(true)
	await nh.change(setup)
	expect(change).not.toHaveBeenCalled()
	await nh.recoverConfiguration()
	expect(nh.blocked).toBe(true)
	expect(nh.error).toContain('does not prove')
	const operationId = nh.configOutcome!.operationId
	result.mockResolvedValue({
		ok: true,
		value: { operationId, status: 'completed', summary: 'Confirmed.', steps: [] },
	})
	await nh.recoverConfiguration()
	expect(nh.blocked).toBe(false)
	expect(result.mock.calls[0][0].operationId).toBe(operationId)
	expect(apply).toHaveBeenCalledTimes(1)
})
it('drops late import previews and receipts after reset', async () => {
	const nh = useNotificationHubs()
	let finish!: (value: unknown) => void
	window.commander.importNotificationHubConfiguration = vi.fn(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	) as never
	const pending = nh.importConfiguration()
	nh.reset()
	finish({
		ok: true,
		value: { cancelled: false, fileName: 'private.json', preview: configPreview() },
	})
	await pending
	expect(nh.configPreview).toBeUndefined()
	expect(nh.configFileName).toBe('')
})
it('drops a late aggregate result without refreshing another connection', async () => {
	const nh = useNotificationHubs()
	nh.configPreview = configPreview()
	let finish!: (value: unknown) => void
	window.commander.applyNotificationHubConfiguration = vi.fn(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	) as never
	const pending = nh.applyConfiguration([crypto.randomUUID()])
	nh.reset()
	finish({
		ok: true,
		value: {
			operationId: crypto.randomUUID(),
			status: 'completed',
			summary: 'Done',
			steps: [],
		},
	})
	await pending
	expect(nh.configOutcome).toBeUndefined()
	expect(list).not.toHaveBeenCalled()
})
it('keeps uncertainty review separate for administrative and aggregate import receipts', async () => {
	const nh = useNotificationHubs()
	nh.outcome = { ...receipt(crypto.randomUUID()), status: 'unknown' }
	nh.reviewed = true
	nh.configOutcome = {
		operationId: crypto.randomUUID(),
		status: 'unknown',
		summary: 'Unknown',
		steps: [],
	}
	expect(nh.blocked).toBe(true)
	nh.configReviewed = true
	expect(nh.blocked).toBe(false)
	nh.reviewed = false
	expect(nh.blocked).toBe(true)
	nh.reset()
	expect(nh.configOutcome).toBeUndefined()
	expect(nh.configReviewed).toBe(false)
})
