import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend } from '../../src/main/platform/backend'
import { NotificationHubRegistrationsController } from '../../src/main/features/notification-hubs/registrations/controller'
import {
	defaultRegistrationQuery,
	nhRegistrationChangeSchema,
	nhRegistrationDraftSchema,
	type NotificationHubRegistrationChange,
} from '../../src/shared/contracts/notification-hubs/registrations'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const xml =
	'<FcmV1TemplateRegistrationDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect"><FcmV1RegistrationId>fixture-token</FcmV1RegistrationId><BodyTemplate><![CDATA[{"message":{"notification":{"body":"$(message)"}}}]]></BodyTemplate><TemplateName>sample</TemplateName></FcmV1TemplateRegistrationDescription>'
let host: Backend, connectionId: string
const req = () => ({ id: randomUUID(), connectionId })
async function start(hubName = 'alerts') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const profile = {
		id: randomUUID(),
		name: 'Fixture',
		service: 'notification-hubs' as const,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'sas' as const,
		tenantId: '',
		clientId: '',
		rememberSecret: false,
		secret: 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;',
	}
	const setup = {
		id: randomUUID(),
		profileId: profile.id,
		hubName,
		source: 'profile' as const,
		managementConnectionId: null,
		policyTarget: null,
		keyType: null,
	}
	connectionId = (await host.request('nh.registrations.connect', { request: setup, profile }))
		.connectionId
	return { profile, setup }
}
afterEach(async () => {
	await host?.stop()
	vi.restoreAllMocks()
})
it('checks production mutation transport, sixteen platform kinds, ETags, XML preservation, rejection and uncertain outcomes', () => {
	expect(
		execFileSync('dotnet', [dll, '--nh-registration-management-checks'], { encoding: 'utf8' }),
	).toContain('registration management checks passed')
})
it('strictly validates acknowledged actions, unique tags and bounded definitions', () => {
	const change = {
		...req(),
		connectionId: randomUUID(),
		action: 'create',
		snapshotId: null,
		draft: { rawXml: xml, tags: ['news', 'customer:123'] },
		acknowledge: true,
	}
	expect(nhRegistrationChangeSchema.safeParse(change).success).toBe(true)
	for (const invalid of [
		{ ...change, acknowledge: false },
		{ ...change, action: 'update' },
		{ ...change, action: 'delete' },
		{ ...change, snapshotId: randomUUID() },
		{ ...change, url: 'https://evil.invalid' },
		{ ...change, draft: { ...change.draft, tags: ['duplicate', 'duplicate'] } },
		{ ...change, draft: { ...change.draft, tags: ['bad tag'] } },
		{
			...change,
			draft: { ...change.draft, tags: Array.from({ length: 61 }, (_, i) => 'tag' + i) },
		},
	])
		expect(nhRegistrationChangeSchema.safeParse(invalid).success).toBe(false)
	expect(
		nhRegistrationDraftSchema.safeParse({ rawXml: 'x'.repeat(131073), tags: [] }).success,
	).toBe(false)
})
it('creates an assigned ID, reads and updates templates/tags, recovers a receipt and conditionally deletes', async () => {
	await start()
	const create: NotificationHubRegistrationChange = {
		...req(),
		action: 'create',
		snapshotId: null,
		draft: { rawXml: xml, tags: ['new'] },
		acknowledge: true,
	}
	const result = await host.request('nh.registrations.change', create)
	expect(result).toMatchObject({ status: 'confirmed', registrationId: 'created-1' })
	expect(await host.request('nh.registrations.change', create)).toEqual(result)
	expect(
		await host.request('nh.registrations.result', { ...req(), operationId: create.id }),
	).toEqual(result)
	const details = await host.request('nh.registrations.get', {
		...req(),
		snapshotId: result.snapshotId!,
	})
	const update = await host.request('nh.registrations.change', {
		...req(),
		action: 'update',
		snapshotId: details.registration.snapshotId,
		draft: { rawXml: details.rawXml.replace('$(message)', '$(body)'), tags: ['changed'] },
		acknowledge: true,
	})
	expect(update).toMatchObject({ status: 'confirmed', etag: 'W/"2"' })
	const fresh = await host.request('nh.registrations.get', {
		...req(),
		snapshotId: update.snapshotId!,
	})
	expect(fresh.templateBody).toContain('$(body)')
	expect(fresh.registration.tags).toEqual(['changed'])
	expect(
		(
			await host.request('nh.registrations.change', {
				...req(),
				action: 'delete',
				snapshotId: fresh.registration.snapshotId,
				draft: null,
				acknowledge: true,
			})
		).status,
	).toBe('confirmed')
	await expect(
		host.request('nh.registrations.get', {
			...req(),
			snapshotId: fresh.registration.snapshotId,
		}),
	).rejects.toThrow('no longer exists')
})
it('requires fresh reads, rejects stale ETags and allows an explicit reviewed reload', async () => {
	await start('conflict')
	const page = await host.request('nh.registrations.query', {
		...req(),
		query: defaultRegistrationQuery(),
		continuationToken: null,
	})
	const snapshotId = page.items[0].snapshotId
	await expect(
		host.request('nh.registrations.change', {
			...req(),
			action: 'delete',
			snapshotId,
			draft: null,
			acknowledge: true,
		}),
	).rejects.toThrow('Reload')
	const fresh = await host.request('nh.registrations.get', { ...req(), snapshotId })
	const failed = await host.request('nh.registrations.change', {
		...req(),
		action: 'delete',
		snapshotId: fresh.registration.snapshotId,
		draft: null,
		acknowledge: true,
	})
	expect(failed.status).toBe('failed')
	expect(failed.summary).toContain('ETag conflict')
	const newer = await host.request('nh.registrations.get', {
		...req(),
		snapshotId: fresh.registration.snapshotId,
	})
	expect(newer.etag).toBe('W/"43"')
	expect(
		(
			await host.request('nh.registrations.change', {
				...req(),
				action: 'delete',
				snapshotId: newer.registration.snapshotId,
				draft: null,
				acknowledge: true,
			})
		).status,
	).toBe('confirmed')
})
it('retains an uncertain accepted create without retrying and can find the assigned registration by tag', async () => {
	await start('uncertain')
	const create: NotificationHubRegistrationChange = {
		...req(),
		action: 'create',
		snapshotId: null,
		draft: { rawXml: xml, tags: ['unique-new'] },
		acknowledge: true,
	}
	const result = await host.request('nh.registrations.change', create)
	expect(result).toMatchObject({ status: 'unknown', registrationId: null })
	expect(JSON.stringify(result)).not.toContain('SECRET')
	expect(await host.request('nh.registrations.change', create)).toEqual(result)
	const page = await host.request('nh.registrations.query', {
		...req(),
		query: { ...defaultRegistrationQuery(), mode: 'tag', value: 'unique-new' },
		continuationToken: null,
	})
	expect(page.items.map((i) => i.registrationId)).toEqual(['created-1'])
})
it('preserves an uncertain receipt when a dispatched write is cancelled', async () => {
	await start('write-slow')
	const abort = new AbortController(),
		id = randomUUID()
	const pending = host.request(
		'nh.registrations.change',
		{
			id,
			connectionId,
			action: 'create',
			snapshotId: null,
			draft: { rawXml: xml, tags: [] },
			acknowledge: true,
		},
		{ signal: abort.signal, waitForCancellation: true },
	)
	setTimeout(() => abort.abort(), 120)
	expect((await pending).status).toBe('unknown')
	expect(
		(await host.request('nh.registrations.result', { ...req(), operationId: id }))?.status,
	).toBe('unknown')
})
it('rejects stale main-process reads and waits for a truthful cancelled write receipt', async () => {
	const { profile, setup } = await start()
	const controller = new NotificationHubRegistrationsController(
		host,
		() => {
			throw new Error('Unexpected ARM access')
		},
		() => profile,
		() => {},
	)
	const { secret: _secret, rememberSecret: _remember, ...metadata } = profile
	const active = await controller.connect(
		setup,
		{ ...metadata, secretState: 'session' },
		new AbortController().signal,
	)
	connectionId = active.connectionId
	const page = await host.request('nh.registrations.query', {
		...req(),
		query: defaultRegistrationQuery(),
		continuationToken: null,
	})
	const original = host.request.bind(host)
	let finish!: () => void
	vi.spyOn(host, 'request').mockImplementation(async (method, value, options) => {
		const result = await original(method, value as never, options)
		if (method === 'nh.registrations.get')
			await new Promise<void>((resolve) => {
				finish = resolve
			})
		return result as never
	})
	const pending = controller.get(
		{ ...req(), snapshotId: page.items[0].snapshotId },
		new AbortController().signal,
	)
	await vi.waitFor(() => expect(finish).toBeDefined())
	controller.forget()
	finish()
	await expect(pending).rejects.toThrow('cancelled')
	vi.restoreAllMocks()
	const reconnected = await controller.connect(
		{ ...setup, id: randomUUID() },
		{ ...metadata, secretState: 'session' },
		new AbortController().signal,
	)
	connectionId = reconnected.connectionId
	const request = vi
		.spyOn(host, 'request')
		.mockRejectedValueOnce(new Error('Malformed write receipt'))
	await expect(
		controller.change(
			{
				...req(),
				action: 'create',
				snapshotId: null,
				draft: { rawXml: xml, tags: [] },
				acknowledge: true,
			},
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
	expect(request.mock.calls[0][2]).toMatchObject({ waitForCancellation: true, timeout: 45000 })
})
