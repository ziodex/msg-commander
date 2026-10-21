import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { useNotificationHubRegistrations } from '../../src/renderer/src/features/notification-hubs/stores/notification-hub-registrations'
import { defaultRegistrationQuery } from '../../src/shared/contracts/notification-hubs/registrations'
const query = vi.fn(),
	inspect = vi.fn(),
	connect = vi.fn(),
	get = vi.fn(),
	change = vi.fn(),
	recover = vi.fn(),
	importFile = vi.fn(),
	inspectFile = vi.fn(),
	exportFile = vi.fn(),
	applyFile = vi.fn(),
	recoverFile = vi.fn()
let pinia: Pinia
const page = (next: string | null = null) => ({
	items: [],
	continuationToken: next,
	capturedAt: new Date().toISOString(),
})
beforeEach(() => {
	vi.resetAllMocks()
	vi.stubGlobal('window', {
		commander: {
			importNotificationHubRegistrations: importFile,
			inspectNotificationHubRegistrationImport: inspectFile,
			exportNotificationHubRegistrations: exportFile,
			applyNotificationHubRegistrationImport: applyFile,
			getNotificationHubRegistrationImportResult: recoverFile,
			getNotificationHubRegistration: get,
			changeNotificationHubRegistration: change,
			getNotificationHubRegistrationResult: recover,
			queryNotificationHubRegistrations: query,
			inspectNotificationHubRegistration: inspect,
			connectNotificationHubRegistrations: connect,
		},
	})
	pinia = createPinia()
	setActivePinia(pinia)
	useNotificationHubRegistrations().connection = {
		connectionId: crypto.randomUUID(),
		profileId: crypto.randomUUID(),
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		connectedAt: new Date().toISOString(),
	}
})
afterEach(() => {
	disposePinia(pinia)
	vi.unstubAllGlobals()
})
it('pages with the applied query, preserves failures and retries the same next cursor', async () => {
	const store = useNotificationHubRegistrations(),
		next = crypto.randomUUID()
	query.mockResolvedValueOnce({ ok: true, value: page(next) })
	await store.search({ ...defaultRegistrationQuery(), mode: 'tag', value: 'news' })
	expect(store.pageNumber).toBe(1)
	query.mockResolvedValueOnce({
		ok: false,
		error: { code: 'AZURE', message: 'Temporary failure' },
	})
	await store.next()
	expect(store.pageNumber).toBe(1)
	expect(store.page?.continuationToken).toBe(next)
	expect(store.error).toContain('Temporary')
	query.mockResolvedValueOnce({ ok: true, value: page() })
	await store.next()
	expect(store.pageNumber).toBe(2)
	expect(query.mock.calls[1][0].continuationToken).toBe(query.mock.calls[2][0].continuationToken)
	expect(query.mock.calls[2][0].query.value).toBe('news')
	query.mockResolvedValueOnce({ ok: true, value: page(next) })
	await store.previous()
	expect(store.pageNumber).toBe(1)
	expect(query.mock.calls[3][0].continuationToken).toBe(null)
})
it('discards late pages and modal inspection after reset', async () => {
	const store = useNotificationHubRegistrations()
	let finish!: (v: unknown) => void
	query.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.search(defaultRegistrationQuery())
	store.reset()
	finish({ ok: true, value: page() })
	await pending
	expect(store.page).toBeUndefined()
	expect(store.busy).toBe('')
})
it('keeps a successful page while an invalid or failed refresh is reviewed and sends cloneable IPC', async () => {
	const store = useNotificationHubRegistrations()
	query.mockImplementation(async (value) => {
		expect(() => structuredClone(value)).not.toThrow()
		return { ok: true, value: page() }
	})
	await store.search(defaultRegistrationQuery())
	const prior = store.page
	query.mockResolvedValueOnce({
		ok: false,
		error: { code: 'CANCELLED', message: 'Operation cancelled.' },
	})
	await store.search({ ...defaultRegistrationQuery(), mode: 'tag', value: 'slow' })
	expect(store.page).toEqual(prior)
	expect(store.query.mode).toBe('all')
	expect(store.error).toContain('cancelled')
})
it('never retains a late connection or chains a query after a reset', async () => {
	const store = useNotificationHubRegistrations()
	let finish!: (v: unknown) => void
	connect.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.connect({
		profileId: crypto.randomUUID(),
		hubName: 'alerts',
		source: 'profile',
		managementConnectionId: null,
		policyTarget: null,
		keyType: null,
	})
	store.reset()
	finish({ ok: true, value: { connectionId: crypto.randomUUID() } })
	await pending
	expect(store.connection).toBeUndefined()
	expect(query).not.toHaveBeenCalled()
})
it('drops late inspection snapshots when a profile or backend resets', async () => {
	const store = useNotificationHubRegistrations()
	let finish!: (v: unknown) => void
	inspect.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.inspect(crypto.randomUUID())
	store.reset()
	finish({ ok: true, value: { rawXml: 'stale device data' } })
	await pending
	expect(store.details).toBeUndefined()
	expect(store.error).toBe('')
})

const receipt = (status: 'confirmed' | 'unknown' | 'failed') => ({
	operationId: crypto.randomUUID(),
	action: 'create' as const,
	status,
	summary: 'Retained receipt',
	registrationId: status === 'confirmed' ? 'new' : null,
	etag: null,
	snapshotId: null,
})
const createDraft = () => ({
	action: 'create' as const,
	snapshotId: null,
	draft: { rawXml: '<RegistrationDescription />', tags: ['news'] },
	acknowledge: true as const,
})
it('sends cloneable drafts and reports failed receipts truthfully', async () => {
	const store = useNotificationHubRegistrations()
	change.mockImplementation(async (value) => {
		expect(() => structuredClone(value)).not.toThrow()
		return { ok: true, value: receipt('failed') }
	})
	await store.openEditor('create')
	await store.change(createDraft())
	expect(store.outcome?.status).toBe('failed')
	const { useWorkspace } = await import('../../src/renderer/src/shared/workspace/store')
	expect(useWorkspace().jobs[0].status).toBe('failed')
})
it('blocks writes after a lost response, recovers receipts and requires review for another write', async () => {
	const store = useNotificationHubRegistrations()
	await store.openEditor('create')
	change.mockRejectedValueOnce(new Error('transport lost'))
	await store.change(createDraft())
	expect(store.outcome?.status).toBe('unknown')
	expect(store.blocked).toBe(true)
	await store.change(createDraft())
	expect(change).toHaveBeenCalledTimes(1)
	recover.mockResolvedValueOnce({ ok: true, value: receipt('unknown') })
	await store.recover()
	expect(store.blocked).toBe(true)
	store.reviewed = true
	expect(store.blocked).toBe(false)
	await store.openEditor('create')
	expect(store.outcome).toBeUndefined()
})
it('does not treat a missing retained receipt as rejection', async () => {
	const store = useNotificationHubRegistrations()
	store.outcome = receipt('unknown')
	recover.mockResolvedValueOnce({ ok: true, value: null })
	await store.recover()
	expect(store.outcome.status).toBe('unknown')
	expect(store.blocked).toBe(true)
	expect(store.error).toContain('does not prove')
})
it('never restores mutation results or editor data after a connection reset', async () => {
	const store = useNotificationHubRegistrations()
	let finish!: (v: unknown) => void
	change.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.change(createDraft())
	store.reset()
	finish({ ok: true, value: receipt('confirmed') })
	await pending
	expect(store.outcome).toBeUndefined()
	expect(store.editor).toBeUndefined()
	expect(store.busy).toBe('')
})

const filePreview = () => ({
	importId: crypto.randomUUID(),
	sourceNamespace: 'Unknown',
	sourceHub: 'Unknown',
	destinationNamespace: 'fixture.servicebus.windows.net',
	destinationHub: 'alerts',
	expiresAt: new Date(Date.now() + 600000).toISOString(),
	entries: [
		{
			id: crypto.randomUUID(),
			registrationId: null,
			kind: 'FcmV1RegistrationDescription',
			platform: 'FCM v1',
			template: false,
			tags: [],
			handle: 'copy-token',
			action: 'create' as const,
			issue: null,
		},
	],
	warnings: [],
})
it('drops late file previews and definitions after reset', async () => {
	const store = useNotificationHubRegistrations()
	let finish!: (v: unknown) => void
	importFile.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.importFile()
	store.reset()
	finish({
		ok: true,
		value: { cancelled: false, fileName: 'private.json', preview: filePreview() },
	})
	await pending
	expect(store.filePreview).toBeUndefined()
	expect(store.fileName).toBe('')
})
it('sends cloneable selections, consumes the preview, retains partial receipts and refreshes after a known result', async () => {
	const store = useNotificationHubRegistrations()
	store.filePreview = filePreview()
	const ids = store.filePreview.entries.map((e) => e.id),
		importId = store.filePreview.importId
	applyFile.mockImplementation(async (value) => {
		expect(() => structuredClone(value)).not.toThrow()
		return {
			ok: true,
			value: {
				operationId: value.id,
				status: 'cancelled',
				summary: '1/2 confirmed',
				steps: [],
			},
		}
	})
	query.mockResolvedValue({ ok: true, value: page() })
	await store.applyFile(ids)
	expect(applyFile.mock.calls[0][0]).toMatchObject({ importId, entryIds: ids, acknowledge: true })
	expect(store.filePreview).toBeUndefined()
	expect(store.fileOutcome?.status).toBe('cancelled')
	expect(query).toHaveBeenCalledTimes(1)
})
it('blocks ordinary and file writes after an uncertain import until its receipt or Azure state is reviewed', async () => {
	const store = useNotificationHubRegistrations()
	store.filePreview = filePreview()
	applyFile.mockRejectedValue(new Error('IPC response lost'))
	await store.applyFile(store.filePreview.entries.map((e) => e.id))
	expect(store.blocked).toBe(true)
	expect(store.fileOutcome?.status).toBe('unknown')
	expect(query).not.toHaveBeenCalled()
	await store.change(createDraft())
	expect(change).not.toHaveBeenCalled()
	recoverFile.mockResolvedValue({ ok: true, value: null })
	await store.recoverFile()
	expect(store.error).toContain('does not prove')
	expect(store.blocked).toBe(true)
	store.fileReviewed = true
	expect(store.blocked).toBe(false)
	store.outcome = receipt('unknown')
	expect(store.blocked).toBe(true)
	store.reviewed = true
	expect(store.blocked).toBe(false)
})
it('retains confirmed recovered import receipts without retrying writes', async () => {
	const store = useNotificationHubRegistrations()
	store.fileOutcome = {
		operationId: crypto.randomUUID(),
		status: 'unknown',
		summary: 'Lost',
		steps: [],
	}
	recoverFile.mockResolvedValue({
		ok: true,
		value: { ...store.fileOutcome, status: 'completed', summary: '2/2 confirmed' },
	})
	await store.recoverFile()
	expect(store.blocked).toBe(false)
	expect(store.fileOutcome?.summary).toBe('2/2 confirmed')
	expect(applyFile).not.toHaveBeenCalled()
})
it('does not restore late import receipts or chain queries after a reset', async () => {
	const store = useNotificationHubRegistrations()
	store.filePreview = filePreview()
	let finish!: (v: unknown) => void
	applyFile.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve
			}),
	)
	const pending = store.applyFile(store.filePreview.entries.map((e) => e.id))
	store.reset()
	finish({
		ok: true,
		value: {
			operationId: crypto.randomUUID(),
			status: 'completed',
			summary: '1/1 confirmed',
			steps: [],
		},
	})
	await pending
	expect(store.fileOutcome).toBeUndefined()
	expect(query).not.toHaveBeenCalled()
})
