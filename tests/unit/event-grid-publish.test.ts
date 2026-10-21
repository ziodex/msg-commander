import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { EventGridController } from '../../src/main/features/event-grid/controller'
import {
	eventGridPublishSchema,
	cloudEventDraftSchema,
	cloudEventJson,
	newCloudEvent,
	type EventGridPublish,
} from '../../src/shared/contracts/event-grid/publishing'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
let host: Backend,
	connectionId: string = randomUUID()
const profile = () => ({
	id: randomUUID(),
	name: 'Event Grid',
	service: 'event-grid' as const,
	namespace: 'fixture.westeurope-1.eventgrid.azure.net',
	auth: 'device-code' as const,
	tenantId: 'fixture',
	clientId: randomUUID(),
	rememberSecret: false,
})
async function start(tenantId = 'fixture') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const p = profile()
	connectionId = (
		await host.request('eg.connect', {
			operationId: randomUUID(),
			profile: p,
			management: { resourceId, tenantId, clientId: p.clientId },
		})
	).connectionId
}
const request = () => ({ id: randomUUID(), connectionId })
const publish = (topicName = 'orders'): EventGridPublish => ({
	...request(),
	topicName,
	mode: 'single',
	drafts: [newCloudEvent()],
	batchSize: 25,
	maxSeconds: 60,
	delayMs: 0,
	acknowledged: true,
})
afterEach(async () => {
	await host?.stop()
})
it('exercises the production publishing transport, precision, authentication, partial sends, cancellation and receipt recovery', () => {
	expect(
		execFileSync('dotnet', [dll, '--event-grid-publish-checks'], { encoding: 'utf8' }),
	).toContain('Event Grid publishing adapter checks passed')
})
it('validates strict bounded CloudEvents requests and event properties', () => {
	const p = publish()
	expect(eventGridPublishSchema.safeParse(p).success).toBe(true)
	for (const patch of [
		{ url: 'https://evil.invalid' },
		{ topicName: '../escape' },
		{ acknowledged: false },
		{ mode: 'binary' },
		{ batchSize: 0 },
		{ batchSize: 101 },
		{ maxSeconds: 301 },
		{ delayMs: 1001 },
		{ drafts: [] },
		{ drafts: [p.drafts[0], p.drafts[0]] },
	])
		expect(eventGridPublishSchema.safeParse({ ...p, ...patch }).success).toBe(false)
	for (const patch of [
		{ dataContentType: 'invalid' },
		{ dataContentType: 'application/xml' },
		{ id: '' },
		{ source: 'invalid space' },
		{ time: 'today' },
		{ dataSchema: 'relative' },
		{ data: '[1,]' },
		{ dataMode: 'base64', data: 'invalid!' },
		{ dataMode: 'none', data: 'present' },
		{ properties: [{ name: 'id', type: 'string', value: 'override' }] },
		{ properties: [{ name: 'Upper', type: 'string', value: 'x' }] },
		{ properties: [{ name: 'n', type: 'integer', value: '2147483648' }] },
		{ properties: [{ name: 'b', type: 'boolean', value: 'True' }] },
	])
		expect(cloudEventDraftSchema.safeParse({ ...p.drafts[0], ...patch }).success).toBe(false)
	expect(
		eventGridPublishSchema.safeParse({
			...p,
			drafts: [{ ...p.drafts[0], data: '"' + '界'.repeat(200000) + '"' }],
		}).success,
	).toBe(false)
})
it('preserves raw JSON precision in preview and encodes JSON, text, base64 and no-data modes', () => {
	const d = {
		...newCloudEvent(),
		data: '{"n":9007199254740993,"d":0.1234567890123456789}',
		properties: [{ name: 'flag', type: 'boolean' as const, value: 'true' }],
	}
	expect(cloudEventJson(d)).toContain(d.data)
	expect(JSON.parse(cloudEventJson(d)).flag).toBe(true)
	expect(
		JSON.parse(cloudEventJson({ ...d, dataMode: 'text', data: '<script>\ntext' })).data,
	).toBe('<script>\ntext')
	expect(JSON.parse(cloudEventJson({ ...d, dataMode: 'base64', data: 'AAEC' })).data_base64).toBe(
		'AAEC',
	)
	expect(JSON.parse(cloudEventJson({ ...d, dataMode: 'none', data: '' }))).not.toHaveProperty(
		'data',
	)
})
it('publishes a single event and multiple batches with progress and read-only result recovery', async () => {
	await start()
	const progress: unknown[] = []
	host.on('event', (e) => {
		if (e.type === 'event-grid-publish-progress') progress.push(e)
	})
	const p = publish(),
		single = await host.request('eg.publish', p)
	expect(single).toMatchObject({
		status: 'completed',
		confirmed: 1,
		confirmedBatches: 1,
		uncertain: 0,
	})
	const batch = {
		...publish(),
		mode: 'batch' as const,
		drafts: [newCloudEvent(), newCloudEvent(), newCloudEvent()],
		batchSize: 2,
	}
	expect(await host.request('eg.publish', batch)).toMatchObject({
		confirmed: 3,
		confirmedBatches: 2,
	})
	expect(progress).toContainEqual(expect.objectContaining({ phase: 'finished', confirmed: 3 }))
	expect(await host.request('eg.publish', p)).toEqual(single)
	await expect(host.request('eg.publish', { ...p, drafts: [newCloudEvent()] })).rejects.toThrow(
		/different request/,
	)
	expect(await host.request('eg.publish.result', { ...request(), operationId: p.id })).toEqual(
		single,
	)
})
it('retains unknown acknowledgments and sanitized explicit rejections without automatic retry', async () => {
	await start()
	expect(await host.request('eg.publish', publish('publish-denied'))).toMatchObject({
		status: 'failed',
		uncertain: 0,
		confirmed: 0,
	})
	const p = publish('publish-lost'),
		lost = await host.request('eg.publish', p)
	expect(lost).toMatchObject({
		status: 'unknown',
		confirmed: 0,
		uncertain: 1,
		lastBatchFirstIndex: 1,
		lastBatchCount: 1,
	})
	expect(JSON.stringify(lost)).not.toContain('SECRET')
	expect(await host.request('eg.publish.result', { ...request(), operationId: p.id })).toEqual(
		lost,
	)
})
it('waits for cancellation classification after dispatch instead of losing the receipt', async () => {
	await start()
	const cancel = new AbortController(),
		p = publish('publish-slow')
	const pending = host.request('eg.publish', p, {
		signal: cancel.signal,
		waitForCancellation: true,
	})
	setTimeout(() => cancel.abort(), 200)
	const value = await pending
	expect(value).toMatchObject({ status: 'unknown', reason: 'cancelled', uncertain: 1 })
	expect(await host.request('eg.publish.result', { ...request(), operationId: p.id })).toEqual(
		value,
	)
})
it('rejects invalid raw backend drafts before dispatch and expires retained results on reconnect', async () => {
	await start()
	await expect(
		host.request('eg.publish', {
			...publish(),
			drafts: [{ ...newCloudEvent(), data: '{"x":1,"x":2}' }],
		}),
	).rejects.toThrow(/valid CloudEvents/)
	const p = publish()
	await host.request('eg.publish', p)
	await host.request('eg.reset', {})
	await expect(
		host.request('eg.publish.result', { ...request(), operationId: p.id }),
	).rejects.toThrow(/expired/)
})
it('keeps write acknowledgments after late controller cancellation and rejects stale connections', async () => {
	await start()
	const controller = new EventGridController(host, () => {}),
		p = profile(),
		signal = new AbortController()
	const connection = await controller.connect(
		{
			id: randomUUID(),
			profileId: p.id,
			management: { resourceId, tenantId: 'fixture', clientId: p.clientId },
		},
		{ ...p, secretState: 'none' },
		signal.signal,
	)
	const value = await controller.publish(
		{ ...publish(), connectionId: connection.connectionId },
		signal.signal,
	)
	signal.abort()
	expect(value.status).toBe('completed')
	await controller.reset()
	await expect(
		controller.publish(
			{ ...publish(), connectionId: connection.connectionId },
			new AbortController().signal,
		),
	).rejects.toThrow(/Connect/)
})

it('cancels renewed data sign-in before dispatch with no uncertain events', async () => {
	await start('publish-renew')
	const cancel = new AbortController()
	const code = new Promise<void>((resolve) =>
		host.on('event', (e) => {
			if (e.type === 'device-code' && e.code === 'OFFLINE-GRID-PUBLISH') resolve()
		}),
	)
	const pending = host.request('eg.publish', publish(), {
		signal: cancel.signal,
		waitForCancellation: true,
	})
	await code
	cancel.abort()
	expect(await pending).toMatchObject({
		status: 'cancelled',
		confirmed: 0,
		uncertain: 0,
		lastBatchFirstIndex: null,
	})
})
