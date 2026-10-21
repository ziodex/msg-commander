import { afterEach, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { RecoveryHarness } from './support/recovery-harness'
import { HostError } from '../../src/main/platform/backend'
import { entityPath } from '../../src/shared/entity-management'
import type { EntityTarget } from '../../src/shared/service-bus'
import type {
	MessagingConfigTarget,
	MessagingConfigPreview,
} from '../../src/shared/contracts/resource-configuration'

let harness: RecoveryHarness
const created: EntityTarget[] = []
const request = () => ({ ...harness.request(), service: 'service-bus' as const })
const target = (
	kind: MessagingConfigTarget['kind'],
	name: string,
	parentKind: MessagingConfigTarget['parentKind'] = null,
	parentName: string | null = null,
): MessagingConfigTarget => ({ kind, name, parentKind, parentName })
const archive = (resources: unknown[]) =>
	Buffer.from(
		JSON.stringify({
			format: 'msg-commander/messaging-configuration',
			version: 1,
			service: 'service-bus',
			exportedAt: new Date().toISOString(),
			sourceNamespace: 'localhost',
			resources,
			warnings: [],
		}),
	).toString('base64')
const resource = (
	address: MessagingConfigTarget,
	settings: unknown = {},
	rulesSpecified = false,
) => ({ target: address, settings, rulesSpecified, issue: null })
const preview = (contentBase64: string) =>
	harness.host.request('sb.config.preview', { ...request(), contentBase64 })
const execution = (review: MessagingConfigPreview) => ({
	...request(),
	importId: review.importId,
	entryIds: review.entries.map((entry) => entry.id),
	acknowledged: true as const,
})

it('blocks configuration writes while a receiver is owned and preserves the review for explicit release', async () => {
	await harness.seed()
	const exported = await harness.host.request('sb.config.export', {
		...request(),
		scope: target('queue', harness.queue.name),
		format: 'json',
		includePolicies: false,
	})
	const document = JSON.parse(Buffer.from(exported.contentBase64, 'base64').toString('utf8'))
	const destination: EntityTarget = { kind: 'queue', name: `guarded-config-${randomUUID()}` }
	created.push(destination)
	const review = await preview(
		archive([resource(target('queue', destination.name), document.resources[0].settings)]),
	)
	expect(review.entries).toHaveLength(1)
	const delivery = (await harness.receive()).items[0]
	const input = execution(review)
	await expect(harness.host.request('sb.config.apply', input)).rejects.toThrow(
		/Close the current message or session receiver/,
	)
	expect(
		await harness.host.request('sb.config.result', { ...request(), operationId: input.id }),
	).toBeNull()
	expect((await harness.host.request('sb.deliveries', harness.request())).items[0]).toMatchObject(
		{
			deliveryId: delivery.deliveryId,
			state: 'active',
		},
	)
	expect(
		await harness.host.request('sb.settle', {
			...harness.request(),
			deliveryId: delivery.deliveryId,
			action: 'complete',
			reason: '',
			description: '',
		}),
	).toMatchObject({ status: 'confirmed' })
	await harness.host.request('sb.close-receiver', harness.request())
	const applied = await harness.host.request('sb.config.apply', input)
	expect(applied).toMatchObject({
		status: 'completed',
		steps: [expect.objectContaining({ status: 'confirmed' })],
	})
	expect(
		(
			await harness.observer.request('sb.entity-config', {
				...harness.control(),
				target: destination,
			})
		).settings,
	).toEqual(document.resources[0].settings)
})

beforeEach(async () => {
	created.length = 0
	harness = new RecoveryHarness()
	await harness.start()
})
afterEach(async () => {
	try {
		for (const address of created.reverse()) {
			try {
				const current = await harness.observer.request('sb.entity-config', {
					...harness.control(),
					target: address,
				})
				expect(
					await harness.observer.request('sb.entity.delete', {
						...harness.control(),
						target: address,
						expectedRevision: current.revision,
						confirmation: entityPath(address),
					}),
				).toMatchObject({ status: 'confirmed' })
			} catch (error) {
				if (!(error instanceof HostError && error.code === '-32004')) throw error
			}
		}
	} finally {
		await harness?.close()
	}
})

it('exports, reviews and imports queue configuration through production ports with retained receipts', async () => {
	const exported = await harness.host.request('sb.config.export', {
		...request(),
		scope: target('queue', harness.queue.name),
		format: 'json',
		includePolicies: false,
	})
	const document = JSON.parse(Buffer.from(exported.contentBase64, 'base64').toString('utf8'))
	expect(exported.count).toBe(1)
	expect(document.resources).toHaveLength(1)
	expect(JSON.stringify(document)).not.toContain('SAS_KEY_VALUE')
	const destination: EntityTarget = { kind: 'queue', name: `config-${randomUUID()}` }
	created.push(destination)
	const originalSettings = structuredClone(document.resources[0].settings)
	document.resources[0].target.name = destination.name
	document.resources[0].settings.userMetadata = 'Configuration café'
	const review = await preview(Buffer.from(JSON.stringify(document)).toString('base64'))
	expect(review.entries).toHaveLength(1)
	expect(review.entries[0]).toMatchObject({ action: 'create', issue: null, phase: 'resource' })
	const input = execution(review)
	const applied = await harness.host.request('sb.config.apply', input)
	expect(applied).toMatchObject({
		status: 'completed',
		steps: [expect.objectContaining({ status: 'confirmed' })],
	})
	expect(await harness.host.request('sb.config.apply', input)).toEqual(applied)
	expect(
		await harness.host.request('sb.config.result', { ...request(), operationId: input.id }),
	).toEqual(applied)
	const settings = (
		await harness.observer.request('sb.entity-config', {
			...harness.control(),
			target: destination,
		})
	).settings
	await mkdir('artifacts', { recursive: true })
	await writeFile(
		'artifacts/refactor-configuration-queue-evidence.json',
		JSON.stringify(
			{ expected: document.resources[0].settings, actual: settings, review, applied },
			null,
			2,
		),
	)
	// The emulator accepts UserMetadata in the management request but returns an empty value.
	// SDK transport checks cover the original UTF-8 field; this records the local broker's limit.
	expect(settings).toEqual({ ...document.resources[0].settings, userMetadata: '' })
	expect(
		(
			await harness.observer.request('sb.entity-config', {
				...harness.control(),
				target: harness.queue,
			})
		).settings,
	).toEqual(originalSettings)
})

it('stages a new subscription behind its false guard, installs reviewed rules and activates only after verification', async () => {
	const topic: EntityTarget = { kind: 'topic', name: `config-${randomUUID()}` }
	const subscription: EntityTarget = {
		kind: 'subscription',
		name: 'billing',
		topicName: topic.name,
	}
	created.push(topic, subscription)
	const content = archive([
		resource(target('topic', topic.name), { defaultMessageTimeToLive: '01:00:00' }),
		resource(
			target('subscription', subscription.name, 'topic', topic.name),
			{ defaultMessageTimeToLive: '01:00:00' },
			true,
		),
		resource(
			target(
				'rule',
				'reviewed',
				'subscription',
				`${topic.name}/Subscriptions/${subscription.name}`,
			),
			{
				filterType: 'true',
				sqlExpression: '',
				filterParameters: [],
				correlation: null,
				actionExpression: '',
				actionParameters: [],
			},
		),
	])
	const review = await preview(content)
	expect(review.entries.every((entry) => entry.issue === null)).toBe(true)
	expect(review.entries.map((entry) => entry.phase)).toEqual(
		expect.arrayContaining(['resource', 'remove-guard', 'activate']),
	)
	const result = await harness.host.request('sb.config.apply', execution(review))
	await mkdir('artifacts', { recursive: true })
	await writeFile(
		'artifacts/refactor-configuration-subscription-evidence.json',
		JSON.stringify({ review, result }, null, 2),
	)
	expect(result.status).toBe('completed')
	expect(result.steps.every((step) => step.status === 'confirmed')).toBe(true)
	expect(
		(
			await harness.observer.request('sb.entity-config', {
				...harness.control(),
				target: subscription,
			})
		).settings.status,
	).toBe('Active')
	expect(
		(
			await harness.observer.request('sb.rules', {
				...harness.control(),
				target: subscription,
			})
		).items.map((rule) => rule.name),
	).toEqual(['reviewed'])
})

it('rejects cyclic forwarding before creating any reviewed entities', async () => {
	const first: EntityTarget = { kind: 'queue', name: `config-${randomUUID()}` }
	const second: EntityTarget = { kind: 'queue', name: `config-${randomUUID()}` }
	created.push(first, second)
	await expect(
		preview(
			archive([
				resource(target('queue', first.name), { forwardTo: second.name }),
				resource(target('queue', second.name), { forwardTo: first.name }),
			]),
		),
	).rejects.toThrow('cycle or exceeds four hops')
	for (const address of [first, second])
		await expect(
			harness.observer.request('sb.entity-config', { ...harness.control(), target: address }),
		).rejects.toMatchObject({ code: '-32004' })
})
