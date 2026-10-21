import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, truncate } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Backend, HostError } from '../../src/main/platform/backend'
import { MessagingConfigurationFiles } from '../../src/main/features/resource-configuration/files'
import { defaultEntitySettings } from '../../src/shared/entity-management'
import { defaultEventHubSettings } from '../../src/shared/contracts/event-hubs/administration'
import {
	messagingConfigApplySchema,
	type MessagingService,
	type MessagingConfigPreview,
	type MessagingConfigTarget,
} from '../../src/shared/contracts/resource-configuration'
let host: Backend,
	connectionId: string,
	service: MessagingService,
	directory: string,
	path: string | undefined,
	files: MessagingConfigurationFiles
const req = () => ({ id: randomUUID(), connectionId, service }),
	signal = () => new AbortController().signal
const resourceId = (provider: string) =>
	`/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/${provider}/namespaces/fixture`
const fixture = async () =>
	JSON.stringify(
		archive(
			service === 'event-hubs'
				? [
						{
							target: target('hub', 'migrated-telemetry'),
							settings: {
								...defaultEventHubSettings(),
								partitionCount: 4,
								retentionHours: 48,
								userMetadata: 'Telemetry café',
								capture: { mode: 'disabled' },
							},
							rulesSpecified: false,
							issue: null,
						},
						{
							target: target('group', 'analytics', 'hub', 'migrated-telemetry'),
							settings: { userMetadata: '日本語 analytics' },
							rulesSpecified: false,
							issue: null,
						},
						{
							target: target('policy', 'reader', 'hub', 'migrated-telemetry'),
							settings: { rights: ['Listen'] },
							rulesSpecified: false,
							issue: null,
						},
					]
				: [
						entity('migrated-archive', { userMetadata: 'Archive 日本語' }),
						entity('migrated-orders', {
							forwardTo: 'migrated-archive',
							userMetadata: 'Orders café',
						}),
						{
							target: target('topic', 'migrated-events'),
							settings: defaultEntitySettings('topic'),
							rulesSpecified: false,
							issue: null,
						},
						{
							target: target('subscription', 'billing', 'topic', 'migrated-events'),
							settings: defaultEntitySettings('subscription'),
							rulesSpecified: true,
							issue: null,
						},
						...['blue', 'correlated'].map((name) => ({
							target: target(
								'rule',
								name,
								'subscription',
								'migrated-events/Subscriptions/billing',
							),
							settings: {
								filterType: 'sql',
								sqlExpression: 'id = @exact',
								filterParameters: [
									{ name: 'exact', type: 'int64', value: '9223372036854775807' },
								],
								correlation: null,
								actionExpression: '',
								actionParameters: [],
							},
							rulesSpecified: false,
							issue: null,
						})),
						{
							target: target('policy', 'sender', 'queue', 'migrated-orders'),
							settings: { rights: ['Send'] },
							rulesSpecified: false,
							issue: null,
						},
					],
		),
	)
const target = (
	kind: MessagingConfigTarget['kind'],
	name: string,
	parentKind: MessagingConfigTarget['parentKind'] = null,
	parentName: string | null = null,
): MessagingConfigTarget => ({ kind, name, parentKind, parentName })
const archive = (resources: unknown[]) => ({
	format: 'msg-commander/messaging-configuration',
	version: 1,
	service,
	exportedAt: new Date().toISOString(),
	sourceNamespace: 'legacy-source',
	resources,
	warnings: [],
})
const entity = (name: string, patch = {}) => ({
	target: target('queue', name),
	settings: { ...defaultEntitySettings('queue'), ...patch },
	rulesSpecified: false,
	issue: null,
})
async function source(value: unknown) {
	path = join(directory, typeof value === 'string' ? 'entities.xml' : 'config.json')
	await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
	return path
}
async function preview(value: unknown) {
	await source(value)
	return (await files.import(req(), signal())).preview!
}
async function apply(
	value: MessagingConfigPreview,
	selected = value.entries.filter((e) => !e.issue).map((e) => e.id),
) {
	return host.request(service === 'service-bus' ? 'sb.config.apply' : 'eh.config.apply', {
		...req(),
		importId: value.importId,
		entryIds: selected,
		acknowledged: true,
	})
}
async function connect(next: MessagingService, management = true) {
	service = next
	const profile = {
		id: randomUUID(),
		name: 'Fixture',
		service,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'sas' as const,
		tenantId: '',
		clientId: '',
		secret: 'offline',
		rememberSecret: false,
	}
	connectionId = (
		next === 'service-bus'
			? await host.request('sb.connect', { operationId: randomUUID(), profile })
			: await host.request('eh.connect', {
					operationId: randomUUID(),
					profile,
					hubName: 'telemetry',
					management: management
						? {
								resourceId: resourceId('Microsoft.EventHub'),
								tenantId: 'fixture',
								clientId: randomUUID(),
							}
						: null,
				})
	).connectionId
	if (next === 'service-bus' && management)
		await host.request('sb.authorization.connect', {
			...req(),
			context: {
				resourceId: resourceId('Microsoft.ServiceBus'),
				tenantId: 'fixture',
				clientId: randomUUID(),
			},
		})
}
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-messaging-config-'))
	path = undefined
	host = new Backend('dotnet', [
		resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
	])
	await host.start()
	await connect('service-bus')
	files = new MessagingConfigurationFiles(
		host,
		(s, id) => {
			if (s !== service || id !== connectionId)
				throw new HostError('STALE', 'Connection expired')
		},
		{ open: async () => path, save: async () => path },
	)
})
afterEach(async () => {
	await host?.stop()
	await rm(directory, { recursive: true, force: true })
})
it('imports Event Hubs, groups and policy rights through the real SDK transport fixture and preserves Capture on updates', async () => {
	await connect('event-hubs')
	const review = await preview(await fixture())
	expect(review.entries.filter((e) => e.issue)).toEqual([])
	expect(review.entries.find((e) => e.target.kind === 'hub')?.proposed).toMatchObject({
		partitionCount: 4,
		retentionHours: 48,
		capture: { mode: 'disabled' },
	})
	expect((await apply(review)).status).toBe('completed')
	const details = await host.request('eh.admin.get', {
		id: randomUUID(),
		connectionId,
		target: { kind: 'hub', name: 'migrated-telemetry' },
	})
	expect(details.hub).toMatchObject({
		partitionCount: 4,
		retentionHours: 48,
		userMetadata: 'Telemetry café',
	})
	for (const format of ['json'] as const) {
		path = join(directory, `events.${format}`)
		await files.export(
			{ ...req(), scope: target('hub', 'migrated-telemetry'), format, includePolicies: true },
			signal(),
		)
		const content = await readFile(path, 'utf8')
		expect(content).not.toMatch(/OFFLINE-PRIMARY|fixture-eventhub-secret|primaryKey/i)
		expect((await files.import(req(), signal())).preview?.entries.every((e) => !e.issue)).toBe(
			true,
		)
	}
})
it('round-trips modern configuration JSON with exact Int64 rule parameters and no keys', async () => {
	expect((await apply(await preview(await fixture()))).status).toBe('completed')
	path = join(directory, 'modern.msgc.json')
	await files.export(
		{
			...req(),
			scope: target('topic', 'migrated-events'),
			format: 'json',
			includePolicies: false,
		},
		signal(),
	)
	const content = await readFile(path, 'utf8')
	const exported = JSON.parse(content)
	expect(exported.format).toBe('msg-commander/messaging-configuration')
	expect(
		exported.resources.find((r: any) => r.target.kind === 'rule' && r.target.name === 'blue')
			.settings.filterParameters,
	).toContainEqual({ name: 'exact', type: 'int64', value: '9223372036854775807' })
	expect(content).not.toMatch(/"(?:primaryKey|secondaryKey|sharedAccessKey)"\s*:/i)
	expect(
		(await files.import(req(), signal())).preview?.entries.every((entry) => !entry.issue),
	).toBe(true)
})
it('requires complete dependencies and acknowledgement and rejects stale previews before writing', async () => {
	const review = await preview(await fixture()),
		child = review.entries.find((e) => e.target.kind === 'rule')!
	await expect(apply(review, [child.id])).rejects.toThrow('required parent')
	expect(
		messagingConfigApplySchema.safeParse({
			...req(),
			importId: review.importId,
			entryIds: [child.id],
			acknowledged: false,
		}).success,
	).toBe(false)
	const current = await preview(
		archive([entity('orders', { userMetadata: 'imported' }), entity('should-not-create')]),
	)
	const existing = await host.request('sb.entity-config', {
		id: randomUUID(),
		connectionId,
		target: { kind: 'queue', name: 'orders' },
	})
	await host.request('sb.entity.update', {
		id: randomUUID(),
		connectionId,
		target: existing.target,
		settings: { ...existing.settings, userMetadata: 'changed-after-review' },
		expectedRevision: existing.revision,
	})
	await expect(apply(current)).rejects.toThrow('changed after review')
	await expect(
		host.request('sb.entity-config', {
			id: randomUUID(),
			connectionId,
			target: { kind: 'queue', name: 'should-not-create' },
		}),
	).rejects.toThrow()
})
it('reports missing forwarding targets and immutable changes as blocked', async () => {
	const missing = await preview(
		archive([entity('missing-source', { forwardTo: 'does-not-exist' })]),
	)
	expect(missing.entries.find((e) => e.phase === 'forwarding')?.issue).toContain('missing')
	const immutable = await preview(archive([entity('orders', { enablePartitioning: true })]))
	expect(immutable.entries[0].issue).toContain('only be chosen')
})
it('stops after a known failure or uncertain write, retains immutable receipts and never attempts later targets', async () => {
	const review = await preview(
		archive([
			entity('a-confirmed'),
			entity('unknown-entity-import'),
			entity('z-not-attempted'),
		]),
	)
	const request = {
		...req(),
		importId: review.importId,
		entryIds: review.entries.map((e) => e.id),
		acknowledged: true as const,
	}
	const result = await host.request('sb.config.apply', request)
	expect(result.status).toBe('unknown')
	expect(result.steps.map((s) => s.status)).toEqual(['confirmed', 'unknown', 'not-attempted'])
	expect(await host.request('sb.config.apply', request)).toEqual(result)
	expect(await host.request('sb.config.result', { ...req(), operationId: request.id })).toEqual(
		result,
	)
	await expect(
		host.request('sb.config.apply', { ...request, entryIds: request.entryIds.slice(1) }),
	).rejects.toThrow('another request')
	expect(JSON.stringify(result)).not.toContain('SECRET')
	const failed = await preview(archive([entity('denied-entity'), entity('z-never')]))
	expect((await apply(failed)).steps.map((s) => s.status)).toEqual(['failed', 'not-attempted'])
	const lostReadback = await preview(
		archive([entity('unreadable-after-create', { userMetadata: 'unsupported-copy' })]),
	)
	expect((await apply(lostReadback)).status).toBe('unknown')
})
it('rejects duplicate JSON/XML, external entities, foreign namespaces, service mismatch and oversized files; replacement cancellation expires a review', async () => {
	for (const value of [
		'<Entities xmlns="urn:unsupported:configuration"><Queues /></Entities>',
		'<Entities xmlns="urn:foreign"><Queues /></Entities>',
		'<!DOCTYPE Entities [<!ENTITY x SYSTEM "file:///etc/passwd">]><Entities xmlns="urn:unsupported:configuration"><Queues>&x;</Queues></Entities>',
		JSON.stringify(archive([entity('duplicate'), entity('duplicate')])),
		JSON.stringify(archive([entity('one')])).replace('"version":1', '"version":1,"version":2'),
		JSON.stringify({ ...archive([entity('one')]), service: 'event-hubs' }),
	])
		await expect(preview(value)).rejects.toThrow()
	const review = await preview(archive([entity('pending')]))
	path = undefined
	expect(await files.import(req(), signal())).toEqual({ cancelled: true, preview: null })
	await expect(apply(review)).rejects.toThrow('expired')
	const big = await source('x')
	await truncate(big, 524289)
	await expect(files.import(req(), signal())).rejects.toThrow('512 KiB')
})
it('rejects imported and discovered forwarding cycles, permits four hops and checks external destinations before writes', async () => {
	await expect(
		preview(
			archive([
				entity('cycle-a', { forwardTo: 'cycle-b' }),
				entity('cycle-b', { forwardTo: 'cycle-a' }),
			]),
		),
	).rejects.toThrow('cycle')
	const chain = Array.from({ length: 5 }, (_, i) =>
		entity(`chain-${i}`, { forwardTo: i === 4 ? '' : `chain-${i + 1}` }),
	)
	expect((await preview(archive(chain))).entries.some((e) => e.phase === 'forwarding')).toBe(true)
	await expect(
		preview(
			archive([
				...chain.slice(0, 4),
				entity('chain-4', { forwardTo: 'chain-5' }),
				entity('chain-5'),
			]),
		),
	).rejects.toThrow('four hops')
	const orders = await host.request('sb.entity-config', {
		id: randomUUID(),
		connectionId,
		target: { kind: 'queue', name: 'orders' },
	})
	await host.request('sb.entity.update', {
		id: randomUUID(),
		connectionId,
		target: orders.target,
		expectedRevision: orders.revision,
		settings: { ...orders.settings, forwardTo: 'archive' },
	})
	await expect(preview(archive([entity('archive', { forwardTo: 'orders' })]))).rejects.toThrow(
		'cycle',
	)
	const review = await preview(archive([entity('new-forwarding', { forwardTo: 'archive' })]))
	const archiveQueue = await host.request('sb.entity-config', {
		id: randomUUID(),
		connectionId,
		target: { kind: 'queue', name: 'archive' },
	})
	await host.request('sb.entity.update', {
		id: randomUUID(),
		connectionId,
		target: archiveQueue.target,
		expectedRevision: archiveQueue.revision,
		settings: { ...archiveQueue.settings, userMetadata: 'changed dependency' },
	})
	await expect(apply(review)).rejects.toThrow('forwarding destination changed')
	await expect(
		host.request('sb.entity-config', {
			id: randomUUID(),
			connectionId,
			target: { kind: 'queue', name: 'new-forwarding' },
		}),
	).rejects.toThrow()
})
it('blocks missing forwarding dependencies, unlisted existing rules and root-policy downgrades without partial creation', async () => {
	const review = await preview(archive([entity('missing-link', { forwardTo: 'absent' })]))
	await expect(
		apply(
			review,
			review.entries.filter((e) => e.action === 'create').map((e) => e.id),
		),
	).rejects.toThrow('forwarding step')
	await expect(
		host.request('sb.entity-config', {
			id: randomUUID(),
			connectionId,
			target: { kind: 'queue', name: 'missing-link' },
		}),
	).rejects.toThrow()
	const existing = await preview((await fixture()).replaceAll('migrated-events', 'order-events'))
	expect(existing.entries.find((e) => e.target.kind === 'subscription')?.issue).toContain(
		'rules absent from this file',
	)
	const root = await preview(
		archive([
			{
				target: target('policy', 'RootManageSharedAccessKey', 'namespace', ''),
				settings: { rights: ['Send'] },
				rulesSpecified: false,
				issue: null,
			},
		]),
	)
	expect(root.entries[0].issue).toContain('Manage rights')
	await connect('service-bus', false)
	const withoutManagement = await preview(await fixture())
	expect(withoutManagement.entries.find((e) => e.target.kind === 'policy')?.issue).toContain(
		'management',
	)
	expect(
		withoutManagement.entries.some((e) => e.target.kind === 'queue' && e.action === 'create'),
	).toBe(true)
})

it('keeps Capture when importing omitted fields and blocks incompatible Event Hubs tier/partition changes', async () => {
	await connect('event-hubs')
	const t = { kind: 'hub' as const, name: 'telemetry' }
	const existing = await host.request('eh.admin.get', {
		id: randomUUID(),
		connectionId,
		target: t,
	})
	await host.request('eh.admin.change', {
		id: randomUUID(),
		connectionId,
		target: t,
		action: 'update',
		userMetadata: null,
		rights: null,
		keyType: null,
		expectedRevision: existing.revision,
		settings: {
			...existing.hub!,
			capture: {
				mode: 'configure',
				intervalSeconds: 300,
				sizeBytes: 10485760,
				skipEmpty: true,
				storageAccountResourceId: resourceId('Microsoft.Storage').replace(
					'/namespaces/fixture',
					'/storageAccounts/fixturestore',
				),
				blobContainer: 'events',
				archiveNameFormat:
					'{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}',
				identity: 'none',
				userAssignedIdentity: '',
			},
		},
		acknowledged: true,
		confirmation: '',
	})
	const review = await preview(
		archive([
			{
				target: target('hub', 'telemetry'),
				settings: { userMetadata: 'Updated metadata' },
				rulesSpecified: false,
				issue: null,
			},
		]),
	)
	expect(review.entries[0].proposed.capture).toEqual({ mode: 'preserve' })
	expect((await apply(review)).status).toBe('completed')
	const after = await host.request('eh.admin.get', { id: randomUUID(), connectionId, target: t })
	expect(after.properties.find((p) => p.name === 'Capture enabled')?.value).toBe('true')
	const incompatible = await preview(
		archive([
			{
				target: target('hub', 'telemetry'),
				settings: { partitionCount: 4 },
				rulesSpecified: false,
				issue: null,
			},
		]),
	)
	expect(incompatible.entries[0].issue).toContain('Partitions can only be increased')
})
it('records cancellation before dispatch and uncertainty after dispatch, without continuing later steps', async () => {
	for (const [name, metadata, expected] of [
		['a-preflight', 'slow-preflight', 'cancelled'],
		['slow-entity', '', 'unknown'],
	] as const) {
		const review = await preview(
			archive([entity(name, { userMetadata: metadata }), entity('z-later')]),
		)
		const abort = new AbortController()
		const timer = setTimeout(() => abort.abort(), 150)
		const result = await host.request(
			'sb.config.apply',
			{
				...req(),
				importId: review.importId,
				entryIds: review.entries.map((e) => e.id),
				acknowledged: true,
			},
			{ signal: abort.signal, waitForCancellation: true },
		)
		clearTimeout(timer)
		expect(result.status).toBe(expected)
		expect(result.steps[0].status).toBe(expected)
		expect(result.steps.slice(1).every((s) => s.status === 'not-attempted')).toBe(true)
	}
})

it.each(['service-bus', 'event-hubs'] as const)(
	'reviews %s configuration from the previous product name',
	async (next) => {
		await connect(next)
		const content = JSON.parse(await fixture())
		content.format = 'service-bus-commander/messaging-configuration'
		const result = await preview(content)
		expect(result.entries.length).toBeGreaterThan(0)
		expect(result.entries.every((entry) => !entry.issue)).toBe(true)
	},
)
