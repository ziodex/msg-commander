import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { DesktopRecovery } from './support/recovery'

test.skip(
	process.platform !== 'win32' ||
		process.env.COMMANDER_PACKAGED !== '1' ||
		process.env.COMMANDER_EMULATOR !== '1',
	'Windows package and Docker required.',
)

for (const settlement of ['complete', 'defer', 'dead-letter'] as const) {
	test(`retains partial ${settlement} job counts through network loss, cancellation and reconnect`, async () => {
		test.setTimeout(90000)
		const desktop = new DesktopRecovery()
		try {
			await desktop.start()
			await desktop.harness.seed(20)
			const input = desktop.job({
				mode: 'receive',
				body: '',
				contentType: '',
				settlement,
				deadLetterReason: settlement === 'dead-letter' ? 'NetworkTest' : '',
				maxMessages: 20,
				maxSeconds: 30,
				workers: 2,
				batchSize: 2,
				delayMs: 500,
			})
			const pending = desktop.call('runTestJob', input)
			await expect
				.poll(async () => (await desktop.progress(input.id))?.settled ?? 0, {
					timeout: 15000,
				})
				.toBeGreaterThan(0)
			desktop.harness.amqp.cut()
			await desktop.call('cancelOperation', input.id)
			const result = await pending
			expect(['cancelled', 'failed', 'unknown', 'limited']).toContain(result.status)
			expect(result.settled).toBeGreaterThan(0)
			expect(result.settled).toBeLessThan(20)
			expect(result.completed + result.deferred + result.deadLettered).toBe(result.settled)
			expect(result.workerResults.reduce((sum, item) => sum + item.settled, 0)).toBe(
				result.settled,
			)
			expect(
				await desktop.call('getTestJobResult', {
					...desktop.request(),
					operationId: input.id,
				}),
			).toEqual(result)
			const main = (await desktop.harness.peek()).items
			const dead = (await desktop.harness.peek('dead-letter')).items
			const actual =
				settlement === 'complete'
					? 20 - main.length
					: settlement === 'defer'
						? main.filter((item) => item.state === 'Deferred').length
						: dead.length
			expect(actual).toBeGreaterThanOrEqual(result.settled)
			expect(actual).toBeLessThanOrEqual(result.settled + result.uncertain)
			if (settlement === 'defer')
				expect(new Set(result.deferredSequenceNumbers)).toEqual(
					new Set(
						main
							.filter(
								(item) =>
									item.state === 'Deferred' &&
									result.deferredSequenceNumbers.includes(item.sequenceNumber),
							)
							.map((item) => item.sequenceNumber),
					),
				)
			desktop.harness.amqp.restore()
			await desktop.reconnect()
			expect((await desktop.call('listDeliveries', desktop.request())).items).toHaveLength(0)
			const recovered = await desktop.call('peekMessages', {
				...desktop.request(),
				target: desktop.harness.queue,
				subQueue: 'active',
				fromSequenceNumber: '0',
				maxMessages: 25,
			})
			expect(recovered.items.map((item) => item.sequenceNumber)).toEqual(
				main.map((item) => item.sequenceNumber),
			)
			expect(await desktop.call('runTestJob', desktop.job({ maxMessages: 1 }))).toMatchObject(
				{
					status: 'completed',
					sent: 1,
					uncertain: 0,
				},
			)
			await mkdir('artifacts/beta-recovery', { recursive: true })
			await writeFile(
				`artifacts/beta-recovery/packaged-${settlement}.json`,
				JSON.stringify(
					{ result, actual, reconnect: true, nextSendConfirmed: true },
					null,
					2,
				),
			)
		} finally {
			await desktop.close()
		}
	})
}
