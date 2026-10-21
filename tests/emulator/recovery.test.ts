import { afterEach, beforeEach, expect, it } from 'vitest'
import { RecoveryHarness } from './support/recovery-harness'

let test: RecoveryHarness
beforeEach(async () => {
	test = new RecoveryHarness(
		process.env.COMMANDER_RECOVERY_ISOLATED === '1'
			? { amqpPort: 15672, managementPort: 15300 }
			: {},
	)
	await test.start()
})
afterEach(async () => {
	await test?.close()
})

it.each(['complete', 'abandon', 'defer', 'dead-letter'] as const)(
	'retains an unknown %s receipt after a lost broker acknowledgement and reconnects without replay',
	async (action) => {
		await test.seed()
		const held = (await test.receive()).items[0]!
		const input = {
			...test.request(),
			deliveryId: held.deliveryId,
			action,
			reason: action === 'dead-letter' ? 'RecoveryTest' : '',
			description: '',
		}
		const forwarded = test.amqp.forwarded,
			dropped = test.amqp.dropped
		test.amqp.loseResponses()
		const controller = new AbortController()
		const pending = test.host.request('sb.settle', input, {
			signal: controller.signal,
			waitForCancellation: true,
			timeout: 35000,
		})
		try {
			await expect
				.poll(() => test.amqp.forwarded, { timeout: 5000 })
				.toBeGreaterThan(forwarded)
			await expect.poll(() => test.amqp.dropped, { timeout: 5000 }).toBeGreaterThan(dropped)
		} finally {
			controller.abort()
		}
		const result = await pending
		expect(result.status).toBe('unknown')
		expect(
			await test.host.request('sb.outcome', { ...test.request(), operationId: input.id }),
		).toEqual(result)
		const deliveries = await test.host.request('sb.deliveries', test.request())
		expect(deliveries.items[0]).toMatchObject({ deliveryId: held.deliveryId, state: 'unknown' })
		expect(await test.host.request('sb.settle', input)).toEqual(result)
		const sentAfter = test.amqp.forwarded
		const blocked = await test.host.request('sb.settle', { ...input, id: test.request().id })
		expect(blocked.status).toBe('rejected')
		expect(test.amqp.forwarded).toBe(sentAfter)

		// A second independent production client observes what the broker actually applied.
		const main = await test.peek(),
			dead = await test.peek('dead-letter')
		if (action === 'complete') expect(main.items).toHaveLength(0)
		if (action === 'dead-letter') {
			expect(main.items).toHaveLength(0)
			expect(dead.items).toHaveLength(1)
		} else expect(dead.items).toHaveLength(0)
		if (action === 'defer') {
			expect(main.items[0]).toMatchObject({
				state: 'Deferred',
				sequenceNumber: held.summary.sequenceNumber,
			})
			expect(
				(await test.receive(true, held.summary.sequenceNumber)).items[0]?.summary
					.sequenceNumber,
			).toBe(held.summary.sequenceNumber)
		}
		if (action === 'abandon') {
			expect(Date.parse(held.lockedUntil)).toBeGreaterThan(Date.now() + 1000)
			expect((await test.receive(true)).items[0]?.summary.messageId).toBe(
				held.summary.messageId,
			)
		}
		await test.observer.request('sb.close-receiver', test.control())
		test.amqp.restore()
		const oldConnection = test.connectionId
		await test.reconnect()
		expect(test.connectionId).not.toBe(oldConnection)
		expect((await test.host.request('sb.deliveries', test.request())).items).toHaveLength(0)
		expect((await test.peek('dead-letter', false)).items).toHaveLength(dead.items.length)
		const next = await test.host.request('sb.test.run', test.job({ maxMessages: 1 }))
		expect(next).toMatchObject({ sent: 1, status: 'completed', uncertain: 0 })
	},
)

it('recovers from management network loss with an explicit new connection', async () => {
	test.management.cut()
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), 1500)
	try {
		await expect(
			test.host.request(
				'sb.connect',
				{ operationId: test.request().id, profile: test.profile },
				{ signal: controller.signal, waitForCancellation: true, timeout: 10000 },
			),
		).rejects.toThrow()
	} finally {
		clearTimeout(timer)
		test.management.restore()
	}
	await test.connect()
	expect(
		(await test.host.request('sb.list', { ...test.request(), kind: 'queue' })).items.some(
			(item) => item.target.name === test.queue.name,
		),
	).toBe(true)
	expect(await test.host.request('sb.test.run', test.job({ maxMessages: 1 }))).toMatchObject({
		status: 'completed',
		sent: 1,
	})
})

it('bounds a concurrent send job during TCP loss, retains its result and resumes explicitly', async () => {
	const input = test.job({ maxMessages: 100, workers: 3, batchSize: 2, delayMs: 500 })
	let cut = false
	test.host.on('event', (event) => {
		if (
			!cut &&
			event.type === 'test-job-progress' &&
			event.operationId === input.id &&
			event.sent >= 2
		) {
			cut = true
			test.amqp.cut()
		}
	})
	const result = await test.host.request('sb.test.run', input, { timeout: 45000 })
	expect(cut).toBe(true)
	expect(['failed', 'unknown', 'limited']).toContain(result.status)
	expect(result.sent).toBeGreaterThan(0)
	expect(result.sent).toBeLessThan(100)
	expect(
		await test.host.request('sb.test.result', { ...test.request(), operationId: input.id }),
	).toEqual(result)
	const actual = (await test.peek()).items.length
	expect(actual).toBeGreaterThanOrEqual(result.sent)
	expect(actual).toBeLessThanOrEqual(result.sent + result.uncertain)
	test.amqp.restore()
	await test.reconnect()
	expect((await test.peek('active', false)).items).toHaveLength(actual)
	expect(await test.host.request('sb.test.run', test.job({ maxMessages: 1 }))).toMatchObject({
		status: 'completed',
		sent: 1,
	})
	expect((await test.peek()).items).toHaveLength(actual + 1)
})
