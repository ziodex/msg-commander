import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	resolveResendDestination,
	saveResendReceipt,
} from '../../src/main/features/service-bus/recovery/resend-receipts'
import type { Backend } from '../../src/main/platform/backend'
import type {
	ResendRequest,
	ResendResult,
} from '../../src/shared/contracts/service-bus/maintenance/index'
import type { Profile } from '../../src/shared/contracts'
const profile: Profile = {
	id: randomUUID(),
	name: 'Recovery',
	service: 'service-bus',
	namespace: 'recovery.fixture.servicebus.windows.net',
	auth: 'sas',
	tenantId: '',
	clientId: '',
	secretState: 'protected',
}
const input: ResendRequest = {
	id: randomUUID(),
	connectionId: randomUUID(),
	source: { kind: 'queue', name: 'orders' },
	destination: { kind: 'queue', name: 'recovered' },
	destinationProfileId: profile.id,
	destinationNamespace: profile.namespace,
	mode: 'remove',
	idPolicy: 'new',
	maxMessages: 1,
	maxSeconds: 30,
	acknowledgeNonAtomic: true,
}
const result: ResendResult = {
	operationId: input.id,
	source: input.source,
	subQueue: 'dead-letter',
	destination: input.destination,
	sourceNamespace: 'source.servicebus.windows.net',
	destinationNamespace: profile.namespace,
	crossNamespace: true,
	mode: 'remove',
	idPolicy: 'new',
	examined: 1,
	sent: 1,
	removed: 0,
	uncertain: 0,
	copiedNotRemoved: 1,
	elapsedMs: 20,
	status: 'failed',
	reason: 'error',
	sourceSequenceNumber: '9007199254740993',
	outgoingMessageId: 'copy-id',
	summary: 'Source completion was rejected.',
	cleanupWarning: null,
	transfers: [
		{
			sourceSequenceNumber: '9007199254740993',
			originalMessageId: 'original',
			outgoingMessageId: 'copy-id',
			send: 'confirmed',
			source: 'not-removed',
		},
	],
}
let directory: string | undefined
const request = { id: randomUUID(), connectionId: input.connectionId, operationId: input.id }
const backend = () =>
	({ request: vi.fn(async () => result) }) as unknown as Pick<Backend, 'request'>
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true })
	directory = undefined
})
it('unlocks only the reviewed destination and refuses stale/non-Service Bus metadata before credential access', () => {
	const getForBackend = vi.fn(() => ({ ...profile, secret: 'SECRET', rememberSecret: false }))
	const workspace = { list: () => [profile], getForBackend }
	expect(
		resolveResendDestination(
			{ ...input, destinationProfileId: undefined, destinationNamespace: undefined },
			workspace,
		),
	).toBeUndefined()
	for (const bad of [
		{ ...input, destinationProfileId: randomUUID() },
		{ ...input, destinationNamespace: 'changed.servicebus.windows.net' },
	])
		expect(() => resolveResendDestination(bad, workspace)).toThrow('changed')
	expect(() =>
		resolveResendDestination(input, {
			...workspace,
			list: () => [{ ...profile, service: 'event-hubs' }],
		}),
	).toThrow('changed')
	expect(getForBackend).not.toHaveBeenCalled()
	expect(resolveResendDestination(input, workspace)?.secret).toBe('SECRET')
	expect(getForBackend).toHaveBeenCalledExactlyOnceWith(profile.id)
})
it('exports the retained receipt with exact IDs and both step outcomes without re-executing recovery', async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-receipt-'))
	const path = join(directory, 'receipt.json'),
		host = backend(),
		requireConnection = vi.fn()
	expect(
		await saveResendReceipt(
			request,
			new AbortController().signal,
			host,
			requireConnection,
			async () => path,
		),
	).toEqual({ cancelled: false, fileName: 'receipt.json', count: 1 })
	const contents = JSON.parse(await readFile(path, 'utf8'))
	expect(contents).toMatchObject({
		format: 'msg-commander-resend-receipt',
		version: 1,
		result,
	})
	expect(JSON.stringify(contents)).not.toContain('SECRET')
	expect(host.request).toHaveBeenCalledExactlyOnceWith(
		'sb.deadletters.result',
		expect.objectContaining({ operationId: input.id }),
		expect.anything(),
	)
	expect(await readdir(directory)).toEqual(['receipt.json'])
	if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
})
it('native dialog cancellation creates no file and does not change the receipt', async () => {
	const host = backend()
	expect(
		await saveResendReceipt(
			request,
			new AbortController().signal,
			host,
			() => {},
			async () => undefined,
		),
	).toEqual({ cancelled: true })
	expect(host.request).toHaveBeenCalledTimes(1)
})
it('cancellation or connection expiry while the dialog is open preserves an existing file', async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-receipt-'))
	const path = join(directory, 'receipt.json')
	await writeFile(path, 'previous')
	const controller = new AbortController()
	await expect(
		saveResendReceipt(
			request,
			controller.signal,
			backend(),
			() => {},
			async () => {
				controller.abort()
				return path
			},
		),
	).rejects.toThrow('cancelled')
	let valid = true
	await expect(
		saveResendReceipt(
			request,
			new AbortController().signal,
			backend(),
			() => {
				if (!valid) throw new Error('Connection expired')
			},
			async () => {
				valid = false
				return path
			},
		),
	).rejects.toThrow('expired')
	expect(await readFile(path, 'utf8')).toBe('previous')
})
it('does not open a save dialog for an expired receipt and reports a file error without exposing paths', async () => {
	const host = { request: vi.fn(async () => null) } as unknown as Pick<Backend, 'request'>,
		save = vi.fn(async () => 'unused')
	await expect(
		saveResendReceipt(request, new AbortController().signal, host, () => {}, save),
	).rejects.toThrow('No retained')
	expect(save).not.toHaveBeenCalled()
	directory = await mkdtemp(join(tmpdir(), 'commander-receipt-'))
	await expect(
		saveResendReceipt(
			request,
			new AbortController().signal,
			backend(),
			() => {},
			async () => join(directory!, 'missing', 'receipt.json'),
		),
	).rejects.toThrow('The receipt could not be saved.')
})
