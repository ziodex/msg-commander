import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
	deferredReferencesRequestSchema,
	forgetDeferredRequestSchema,
	deferredReferencesSchema,
} from '../../src/shared/deferred-messages'
it('validates scoped requests and exact bounded Int64 references', () => {
	const request = {
		id: randomUUID(),
		connectionId: randomUUID(),
		target: { kind: 'queue', name: 'orders' },
		subQueue: 'active',
		sessionId: '',
	}
	expect(
		forgetDeferredRequestSchema.parse({ ...request, sequenceNumber: '9223372036854775807' })
			.sequenceNumber,
	).toBe('9223372036854775807')
	expect(
		forgetDeferredRequestSchema.safeParse({ ...request, sequenceNumber: '9223372036854775808' })
			.success,
	).toBe(false)
	expect(
		deferredReferencesRequestSchema.safeParse({
			...request,
			subQueue: 'dead-letter',
			sessionId: 'wrong',
		}).success,
	).toBe(false)
	expect(
		deferredReferencesRequestSchema.safeParse({ ...request, filePath: '/arbitrary' }).success,
	).toBe(false)
	expect(
		deferredReferencesSchema.safeParse({
			total: 101,
			items: Array.from({ length: 101 }, () => ({
				sequenceNumber: '1',
				recordedAt: '2026-10-19T12:00:00Z',
			})),
		}).success,
	).toBe(false)
})
it('preserves deferred records and confirmed broker outcomes across provider lifecycle and failures', () => {
	const output = execFileSync(
		'dotnet',
		[
			resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll'),
			'--message-defer-checks',
		],
		{ encoding: 'utf8', timeout: 20000 },
	)
	expect(output).toContain('Message defer checks passed')
}, 25000)
