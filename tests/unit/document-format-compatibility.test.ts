import { expect, it } from 'vitest'
import { archiveSchema } from '../../src/main/features/service-bus/files/message-archive'
import { eventArchiveSchema } from '../../src/shared/contracts/event-hubs/files'
import { eventCheckpointSchema } from '../../src/shared/contracts/event-hubs/listening'

it('imports previous message archives without changing bodies or exact typed values', () => {
	const messages = [
		{
			bodyBase64: Buffer.from([0, 255, 128]).toString('base64'),
			systemProperties: [],
			applicationProperties: [{ name: 'exact', type: 'int64', value: '9223372036854775807' }],
		},
	]
	const archive = {
		format: 'service-bus-commander/messages',
		version: 1,
		exportedAtUtc: new Date().toISOString(),
		messages,
	}
	expect(archiveSchema.parse(archive)).toEqual({ ...archive, format: 'msg-commander/messages' })
	expect(archiveSchema.safeParse({ ...archive, format: 'another-tool/messages' }).success).toBe(
		false,
	)
	expect(archiveSchema.safeParse({ ...archive, version: 2 }).success).toBe(false)
})
it('imports previous event archives and preserves event metadata', () => {
	const archive = {
		format: 'service-bus-commander/events',
		version: 1,
		exportedAt: new Date().toISOString(),
		events: [
			{
				source: null,
				sequenceNumber: '9223372036854775807',
				offset: '9223372036854775806',
				enqueuedTime: null,
				partitionKey: null,
				messageId: null,
				contentType: null,
				correlationId: null,
				applicationProperties: [],
				systemProperties: [],
				bodyBase64: 'AP+A',
			},
		],
	}
	expect(eventArchiveSchema.parse(archive)).toEqual({
		...archive,
		format: 'msg-commander/events',
	})
	expect(
		eventArchiveSchema.safeParse({ ...archive, format: 'msg-commander/messages' }).success,
	).toBe(false)
})
it('imports previous checkpoints while keeping sequence positions exact and validating partitions', () => {
	const checkpoint = {
		format: 'service-bus-commander/event-checkpoints',
		version: 1,
		namespace: 'fixture.servicebus.windows.net',
		hubName: 'telemetry',
		consumerGroup: '$Default',
		hubCreatedAt: new Date().toISOString(),
		savedAt: new Date().toISOString(),
		partitions: [
			{
				partitionId: '0',
				retentionFloor: '0',
				position: { kind: 'sequence', value: '9223372036854775807', inclusive: false },
			},
		],
	}
	expect(eventCheckpointSchema.parse(checkpoint)).toEqual({
		...checkpoint,
		format: 'msg-commander/event-checkpoints',
	})
	expect(
		eventCheckpointSchema.safeParse({
			...checkpoint,
			partitions: [...checkpoint.partitions, ...checkpoint.partitions],
		}).success,
	).toBe(false)
})
