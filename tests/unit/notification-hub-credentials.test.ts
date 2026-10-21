import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Backend, HostError } from '../../src/main/platform/backend'
import { NotificationHubCredentialFiles } from '../../src/main/features/notification-hubs/credentials/files'
import {
	credentialChangeSchema,
	credentialGetSchema,
	credentialImportSchema,
	credentialDraftSchema,
	credentialStatusSchema,
} from '../../src/shared/contracts/notification-hubs/credentials'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
const resourceId =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
const target = { scope: { kind: 'hub' as const, name: 'alerts' }, policyName: null }
let host: Backend,
	connectionId: string,
	directory: string,
	path: string | undefined,
	files: NotificationHubCredentialFiles
const req = () => ({ id: randomUUID(), connectionId, target })
const signal = () => new AbortController().signal
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-provider-'))
	path = undefined
	host = new Backend('dotnet', [dll])
	await host.start()
	const profile = {
		id: randomUUID(),
		name: 'NotificationHub',
		service: 'notification-hubs' as const,
		namespace: 'fixture.servicebus.windows.net',
		auth: 'device-code' as const,
		tenantId: 'fixture',
		clientId: randomUUID(),
		rememberSecret: false,
	}
	connectionId = (
		await host.request('nh.connect', {
			operationId: randomUUID(),
			profile,
			management: { resourceId, tenantId: 'fixture', clientId: profile.clientId },
		})
	).connectionId
	files = new NotificationHubCredentialFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Connection expired')
		},
		async () => path,
	)
})
afterEach(async () => {
	await host?.stop()
	if (directory) await rm(directory, { recursive: true, force: true })
})
it('exercises real ARM transport, managed P12 validation, provider isolation, stale edits and retained receipts', () => {
	expect(
		execFileSync('dotnet', [dll, '--nh-credentials-checks'], {
			encoding: 'utf8',
			timeout: 30000,
		}),
	).toContain('checks passed')
})
it('imports a native-picked APNS file without returning private bytes, paths or passwords', async () => {
	const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString()
	path = join(directory, 'private-key.p8')
	await writeFile(path, key)
	const result = await files.import({ ...req(), provider: 'apns-token', password: '' }, signal())
	expect(result.cancelled).toBe(false)
	expect(result.artifact?.summary).toContain('P-256')
	expect(JSON.stringify(result)).not.toContain(key.split('\n')[1])
	expect(JSON.stringify(result)).not.toContain(directory)
	const status = await host.request('nh.credentials.get', { ...req(), provider: 'apns-token' })
	const request = {
		...req(),
		expectedRevision: status.revision,
		draft: {
			provider: 'apns-token' as const,
			artifactId: result.artifact!.artifactId,
			environment: 'sandbox' as const,
			keyId: 'ABCDEFGHIJ',
			teamId: '0123456789',
			bundleId: 'com.example.app',
		},
		acknowledged: true as const,
	}
	const receipt = await host.request('nh.credentials.change', request)
	expect(receipt.status).toBe('confirmed')
	expect(await host.request('nh.credentials.change', request)).toEqual(receipt)
	expect(await readFile(path, 'utf8')).toBe(key)
})
it('cancels the picker without any import or Azure write', async () => {
	const request = vi.spyOn(host, 'request')
	expect(await files.import({ ...req(), provider: 'fcm-v1', password: '' }, signal())).toEqual({
		cancelled: true,
		artifact: null,
	})
	expect(request).not.toHaveBeenCalled()
})
it('rejects invalid, oversized and nonregular files with sanitized errors', async () => {
	for (const contents of ['PRIVATE-SENTINEL', Buffer.alloc(262145)]) {
		path = join(directory, 'credential.json')
		await writeFile(path, contents)
		await expect(
			files.import({ ...req(), provider: 'fcm-v1', password: '' }, signal()),
		).rejects.toThrow()
		try {
			await files.import({ ...req(), provider: 'fcm-v1', password: '' }, signal())
		} catch (e) {
			expect(String(e)).not.toContain('PRIVATE-SENTINEL')
			expect(String(e)).not.toContain(directory)
		}
	}
	path = directory
	await expect(
		files.import(
			{ ...req(), provider: 'apns-certificate', password: 'PRIVATE-PASSWORD' },
			signal(),
		),
	).rejects.toThrow()
})
it('drops picker and import results when the management connection changes or cancellation occurs', async () => {
	let release!: (path: string | undefined) => void
	const pendingFiles = new NotificationHubCredentialFiles(
		host,
		(id) => {
			if (id !== connectionId) throw new HostError('STALE', 'Expired')
		},
		() =>
			new Promise((r) => {
				release = r
			}),
	)
	const request = vi.spyOn(host, 'request')
	const pending = pendingFiles.import({ ...req(), provider: 'fcm-v1', password: '' }, signal())
	connectionId = randomUUID()
	release(undefined)
	await expect(pending).rejects.toThrow('Expired')
	expect(request).not.toHaveBeenCalled()
	const abort = new AbortController()
	abort.abort()
	await expect(
		files.import({ ...req(), provider: 'fcm-v1', password: '' }, abort.signal),
	).rejects.toThrow('cancelled')
})
it('rejects arbitrary renderer paths, provider endpoints, extra fields and missing review', () => {
	const base = { ...req(), provider: 'wns' as const }
	expect(credentialGetSchema.safeParse({ ...base, path: '/tmp/private' }).success).toBe(false)
	expect(
		credentialGetSchema.safeParse({
			...base,
			target: { scope: { kind: 'namespace', name: '' }, policyName: null },
		}).success,
	).toBe(false)
	expect(
		credentialImportSchema.safeParse({
			...req(),
			provider: 'apns-token',
			password: 'unexpected',
		}).success,
	).toBe(false)
	expect(
		credentialImportSchema.safeParse({
			...req(),
			provider: 'apns-token',
			password: '',
			contentBase64: 'unsafe',
		}).success,
	).toBe(false)
	expect(
		credentialDraftSchema.safeParse({
			provider: 'wns',
			packageSid: 'sid',
			secretKey: 'secret',
			windowsLiveEndpoint: 'https://evil.invalid',
		}).success,
	).toBe(false)
	expect(
		credentialDraftSchema.safeParse({
			provider: 'adm',
			clientId: 'ok',
			clientSecret: 'bad\nvalue',
		}).success,
	).toBe(false)
	expect(
		credentialChangeSchema.safeParse({
			...req(),
			draft: { provider: 'baidu', apiKey: 'key', secretKey: 'secret' },
			expectedRevision: 'A'.repeat(64),
			acknowledged: false,
		}).success,
	).toBe(false)
	expect(
		credentialStatusSchema.safeParse({
			provider: 'wns',
			configured: true,
			revision: 'A'.repeat(64),
			apiVersion: '2023-09-01',
			secretKey: 'leaked',
		}).success,
	).toBe(false)
})
it('retains scoped status and validates all seven credential draft shapes', async () => {
	for (const provider of [
		'apns-token',
		'apns-certificate',
		'fcm-v1',
		'wns',
		'adm',
		'baidu',
		'mpns-certificate',
	] as const) {
		const status = await host.request('nh.credentials.get', { ...req(), provider })
		expect(status.provider).toBe(provider)
		expect(status.configured).toBe(false)
		expect(status.apiVersion).toBe(provider === 'fcm-v1' ? '2023-10-01-preview' : '2023-09-01')
	}
	for (const draft of [
		{ provider: 'wns', packageSid: 'sid', secretKey: 'secret' },
		{ provider: 'adm', clientId: 'client', clientSecret: 'secret' },
		{ provider: 'baidu', apiKey: 'key', secretKey: 'secret' },
		{
			provider: 'apns-token',
			artifactId: randomUUID(),
			environment: 'production',
			keyId: 'ABCDEFGHIJ',
			teamId: '0123456789',
			bundleId: 'app.example',
		},
		{ provider: 'apns-certificate', artifactId: randomUUID(), environment: 'sandbox' },
		{ provider: 'fcm-v1', artifactId: randomUUID() },
		{ provider: 'mpns-certificate', artifactId: randomUUID() },
	])
		expect(credentialDraftSchema.safeParse(draft).success).toBe(true)
})
