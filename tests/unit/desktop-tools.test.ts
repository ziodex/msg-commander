import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
	desktopPreferencesSchema,
	operationLogSchema,
	formatOperationLog,
} from '../../src/shared/desktop-tools'
import { exportOperationLog } from '../../src/main/features/workspace/desktop-tools'
let directory: string | undefined
afterEach(async () => {
	if (directory) await rm(directory, { recursive: true, force: true })
	directory = undefined
})
const request = () => ({
	destination: 'clipboard' as const,
	entries: [
		{
			id: randomUUID(),
			timestamp: '2026-10-19T12:00:00.000Z',
			label: 'Peek orders',
			status: 'completed' as const,
			message: '2 messages returned',
		},
	],
})
it('exports a timestamped selected snapshot without including credentials', async () => {
	const input = request()
	input.entries[0]!.message =
		'SharedAccessKey=secret-key; AccountKey=storage-key; ClientSecret="private value"; sig=sas-signature&token=token-value\nBearer eyJ.credential.signature\nSharedAccessSignature sr=resource&sig=private&se=123'
	const text = formatOperationLog(input)
	expect(text).toContain('[2026-10-19T12:00:00.000Z] COMPLETED Peek orders')
	for (const secret of [
		'secret-key',
		'storage-key',
		'private value',
		'sas-signature',
		'token-value',
		'eyJ.credential.signature',
		'sig=private',
	])
		expect(text).not.toContain(secret)
	const copy = vi.fn(),
		save = vi.fn()
	await exportOperationLog(input, { copy, save })
	expect(copy).toHaveBeenCalledWith(text)
	expect(save).not.toHaveBeenCalled()
})
it('cancels native saving without writing and saves UTF-8 only to the chosen file', async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-log-'))
	const input = { ...request(), destination: 'file' as const }
	expect(await exportOperationLog(input, { copy: vi.fn(), save: async () => undefined })).toEqual(
		{
			cancelled: true,
		},
	)
	const path = join(directory, 'operations.log')
	expect(await exportOperationLog(input, { copy: vi.fn(), save: async () => path })).toEqual({
		cancelled: false,
		fileName: 'operations.log',
	})
	expect(await readFile(path, 'utf8')).toContain('2 messages returned')
})
it('rejects unbounded logs, paths and unsupported appearance options', () => {
	expect(operationLogSchema.safeParse({ ...request(), path: 'arbitrary.txt' }).success).toBe(
		false,
	)
	expect(
		operationLogSchema.safeParse({
			...request(),
			entries: Array.from({ length: 501 }, () => request().entries[0]),
		}).success,
	).toBe(false)
	expect(
		operationLogSchema.safeParse({
			...request(),
			entries: [{ ...request().entries[0], timestamp: 'yesterday' }],
		}).success,
	).toBe(false)
	expect(
		desktopPreferencesSchema.safeParse({ font: 'plex', accent: 'warm', scale: 1.25 }).success,
	).toBe(true)
	expect(
		desktopPreferencesSchema.safeParse({ font: 'url(remote)', accent: 'warm', scale: 1 })
			.success,
	).toBe(false)
	expect(
		desktopPreferencesSchema.safeParse({ font: 'plex', accent: 'warm', scale: 99 }).success,
	).toBe(false)
})
