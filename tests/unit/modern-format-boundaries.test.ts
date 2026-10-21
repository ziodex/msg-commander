import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import { importMessagesRequestSchema } from '../../src/shared/message-files'
import { eventImportSchema } from '../../src/shared/contracts/event-hubs/files'
import { codecRequestSchema } from '../../src/shared/body-codecs'

let host: Backend | undefined
afterEach(async () => {
	await host?.stop()
})
it('refuses unsupported archive and body formats at the desktop boundary', () => {
	const request = { id: randomUUID(), connectionId: randomUUID() }
	for (const format of ['xml', 'yaml']) {
		expect(importMessagesRequestSchema.safeParse({ ...request, format }).success).toBe(false)
		expect(eventImportSchema.safeParse({ ...request, format }).success).toBe(false)
	}
	for (const format of ['soap', 'binary-xml', 'custom'])
		expect(
			codecRequestSchema.safeParse({
				id: randomUUID(),
				contentBase64: '',
				direction: 'decode',
				format,
				encoding: 'utf8',
				compression: 'none',
				bom: false,
			}).success,
		).toBe(false)
})
it('rejects unknown host methods and unsupported body formats', async () => {
	host = new Backend('dotnet', [
		resolve('backend/MsgCommander.Host/bin/Debug/net10.0/MsgCommander.Host.dll'),
	])
	await host.start()
	for (const method of ['files.run-script', 'plugins.execute', 'unknown.method'])
		await expect(host.request(method as never, {} as never)).rejects.toMatchObject({
			code: '-32601',
		})
	await expect(
		host.request('body.codec', {
			direction: 'decode',
			format: 'soap' as never,
			encoding: 'utf8',
			bom: false,
			contentBase64: '',
		}),
	).rejects.toMatchObject({ code: '-32602' })
})
