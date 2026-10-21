import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostError } from '../../src/main/platform/backend'
import { registerTestJobIpc } from '../../src/main/features/service-bus/test-jobs/register-ipc'
import type { IpcRegistrar, WithOperation } from '../../src/main/ipc/types'
import { createTestJobBridge } from '../../src/preload/features/service-bus/test-jobs'
import type { TestJobRequest } from '../../src/shared/contracts/service-bus/test-jobs'

const handlers = new Map<string, (input: unknown) => unknown>()
const backend = { request: vi.fn() }
const serviceBus = { require: vi.fn() }
const handle: IpcRegistrar = (channel, schema, action) => {
	handlers.set(channel, (input) => action(schema.parse(input)))
}
const withOperation: WithOperation = async (_id, action) => action(new AbortController().signal)
const input = (): TestJobRequest => ({
	id: randomUUID(),
	connectionId: randomUUID(),
	target: { kind: 'queue', name: 'test-jobs' },
	mode: 'send',
	maxMessages: 17,
	maxSeconds: 30,
	delayMs: 0,
	workers: 3,
	batchSize: 5,
	sessionId: '',
	body: '{"test":true}',
	contentType: 'application/json',
	acknowledged: true,
	generator: { kind: 'literal', seed: 1, sizeBytes: 1024 },
	settlement: 'complete',
	deadLetterReason: '',
	deadLetterDescription: '',
})
const call = (channel: string, value: unknown) =>
	Promise.resolve().then(() => handlers.get(channel)!(value))

beforeEach(() => {
	handlers.clear()
	vi.resetAllMocks()
	registerTestJobIpc({ handle, withOperation, backend, serviceBus })
})

it('retains the request, connection guard, deadline and cancellation receipt behavior', async () => {
	const value = input(),
		receipt = { operationId: value.id }
	backend.request.mockResolvedValue(receipt)
	await expect(call('commander:sb-test-run', value)).resolves.toBe(receipt)
	expect(serviceBus.require).toHaveBeenCalledWith(value.connectionId)
	expect(backend.request).toHaveBeenCalledExactlyOnceWith('sb.test.run', value, {
		signal: expect.any(AbortSignal),
		waitForCancellation: true,
		timeout: 90000,
	})
})

for (const code of ['TIMEOUT', 'BACKEND_UNAVAILABLE']) {
	it(`retains an uncertain outcome after ${code} without replaying the job`, async () => {
		backend.request.mockRejectedValue(new HostError(code, 'Interrupted'))
		await expect(call('commander:sb-test-run', input())).rejects.toMatchObject({
			code: 'OUTCOME_UNKNOWN',
		})
		expect(backend.request).toHaveBeenCalledTimes(1)
	})
}

it('rejects stale connections and invalid limits before dispatch', async () => {
	serviceBus.require.mockImplementation(() => {
		throw new HostError('INVALID_REQUEST', 'Connection expired')
	})
	await expect(call('commander:sb-test-run', input())).rejects.toThrow('Connection expired')
	serviceBus.require.mockReset()
	await expect(call('commander:sb-test-run', { ...input(), workers: 9 })).rejects.toThrow()
	expect(backend.request).not.toHaveBeenCalled()
})

it('preserves explicit backend rejection rather than classifying it as uncertain', async () => {
	backend.request.mockRejectedValue(new HostError('INVALID_REQUEST', 'Close the receiver'))
	await expect(call('commander:sb-test-run', input())).rejects.toMatchObject({
		code: 'INVALID_REQUEST',
	})
})

it('looks up the existing receipt through the guarded connection without running a job', async () => {
	const value = { id: randomUUID(), connectionId: randomUUID(), operationId: randomUUID() }
	backend.request.mockResolvedValue(null)
	await expect(call('commander:sb-test-result', value)).resolves.toBeNull()
	expect(serviceBus.require).toHaveBeenCalledWith(value.connectionId)
	expect(backend.request).toHaveBeenCalledExactlyOnceWith('sb.test.result', value, {
		signal: expect.any(AbortSignal),
		timeout: 60000,
	})
})

it('previews generated payloads independently of a Service Bus connection', async () => {
	const value = {
		id: randomUUID(),
		generator: { kind: 'binary', seed: 12, sizeBytes: 64 },
		body: '',
		contentType: '',
		sampleIndex: 1,
	}
	await call('commander:test-payload-preview', value)
	expect(serviceBus.require).not.toHaveBeenCalled()
	expect(backend.request).toHaveBeenCalledExactlyOnceWith('test.payload.preview', value, {
		signal: expect.any(AbortSignal),
		timeout: 10000,
	})
})

it('preserves the three public preload methods and channels', async () => {
	const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
	const bridge = createTestJobBridge(invoke)
	const value = input()
	await bridge.runTestJob(value)
	await bridge.getTestJobResult({
		id: value.id,
		connectionId: value.connectionId,
		operationId: value.id,
	})
	await bridge.previewTestPayload({
		id: value.id,
		generator: value.generator,
		body: value.body,
		contentType: value.contentType,
		sampleIndex: 1,
	})
	expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
		'commander:sb-test-run',
		'commander:sb-test-result',
		'commander:test-payload-preview',
	])
	expect(invoke.mock.calls[0][1]).toBe(value)
})
