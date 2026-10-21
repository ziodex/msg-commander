import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore, type SecretProtection } from '../../src/main/platform/workspace-store'
import { profileInputSchema, type ProfileInput } from '../../src/shared/contracts'
import { secureStorageAvailable, trustedRendererUrl } from '../../src/main/platform/security'

let directory: string
const protection: SecretProtection = {
	available: () => true,
	encrypt: (value) => Buffer.from(`test-only:${value}`),
	decrypt: (value) => value.toString().slice(10),
}
const profile = (): ProfileInput => ({
	id: randomUUID(),
	name: 'Unit test',
	namespace: 'unit.servicebus.windows.net',
	auth: 'sas',
	service: 'service-bus',
	tenantId: '',
	clientId: '',
	secret: 'unit-secret-do-not-persist',
	rememberSecret: false,
})
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'commander-unit-'))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

describe('versioned workspace and secret boundary', () => {
	it('flushes pending connection writes before shutdown and retains protected credentials after migration', async () => {
		const path = join(directory, 'workspace.json')
		const saved = profile()
		const { secret, rememberSecret: _remember, ...metadata } = saved
		const encryptedSecret = protection.encrypt(secret!).toString('base64')
		await writeFile(
			path,
			JSON.stringify({
				version: 1,
				theme: 'system',
				profiles: [{ profile: metadata, encryptedSecret }],
			}),
		)
		const upgrading = new WorkspaceStore(path, protection)
		await upgrading.load()
		const second = profile()
		const writing = upgrading.save({ ...second, rememberSecret: true })
		const theme = upgrading.setTheme('dark')
		await upgrading.flush()
		await Promise.all([writing, theme])
		const reopened = new WorkspaceStore(path, protection)
		await reopened.load()
		expect(reopened.list()).toHaveLength(2)
		expect(reopened.theme).toBe('dark')
		expect(reopened.getForBackend(saved.id).secret).toBe(secret)
		expect(reopened.getForBackend(second.id).secret).toBe(second.secret)
		const stored = JSON.parse(await readFile(path, 'utf8'))
		expect(stored.version).toBe(2)
		expect(
			stored.profiles.find(
				(item: { profile: { id: string } }) => item.profile.id === saved.id,
			).encryptedSecret,
		).toBe(encryptedSecret)
		expect(JSON.stringify(stored)).not.toContain(secret)
	})
	it('requires an explicit Service Bus emulator profile for local endpoints and development transport', async () => {
		const input = {
			...profile(),
			namespace: 'localhost',
			emulatorManagementPort: 5300,
			secret: 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;',
		}
		expect(profileInputSchema.safeParse(input).success).toBe(true)
		expect(
			profileInputSchema.safeParse({ ...input, emulatorManagementPort: undefined }).success,
		).toBe(false)
		expect(profileInputSchema.safeParse({ ...input, service: 'event-hubs' }).success).toBe(
			false,
		)
		expect(
			profileInputSchema.safeParse({ ...input, emulatorManagementPort: 65536 }).success,
		).toBe(false)
		expect(
			profileInputSchema.safeParse({
				...input,
				secret: 'Endpoint=sb://localhost;SharedAccessKeyName=key;SharedAccessKey=value;',
			}).success,
		).toBe(false)
		const path = join(directory, 'emulator.json')
		const store = new WorkspaceStore(path, protection)
		await store.save({ ...input, rememberSecret: true })
		const restored = new WorkspaceStore(path, protection)
		await restored.load()
		expect(restored.getForBackend(input.id)).toMatchObject(input)
		expect(restored.list()[0]).not.toHaveProperty('secret')
	})
	it('loads, lists and edits metadata without accessing a locked credential store', async () => {
		const path = join(directory, 'workspace.json')
		const original = new WorkspaceStore(path, protection)
		const remembered = { ...profile(), rememberSecret: true }
		await original.save(remembered)
		const available = vi.fn(() => {
			throw new Error('Credential store must not be queried implicitly')
		})
		const store = new WorkspaceStore(path, { ...protection, available })
		await store.load()
		expect(store.list()[0].secretState).toBe('protected')
		await store.setTheme('dark')
		const session = profile()
		await store.save(session)
		expect(store.getForBackend(session.id).secret).toBe(session.secret)
		await store.remove(session.id)
		expect(store.list()).toHaveLength(1)
		expect(available).not.toHaveBeenCalled()
		// Connecting with saved ciphertext is an explicit request for OS access.
		expect(() => store.getForBackend(remembered.id)).toThrow('must not be queried implicitly')
		expect(available).toHaveBeenCalledTimes(1)
	})
	it('preserves saved ciphertext when OS access is refused and permits session-only replacement', async () => {
		const path = join(directory, 'workspace.json')
		const original = new WorkspaceStore(path, protection)
		const input = { ...profile(), rememberSecret: true }
		await original.save(input)
		const before = await readFile(path, 'utf8')
		const store = new WorkspaceStore(path, { ...protection, available: () => false })
		await store.load()
		expect(store.list()[0].secretState).toBe('protected')
		expect(() => store.getForBackend(input.id)).toThrow('Unlock your OS credential store')
		await expect(store.save({ ...input, secret: 'replacement-secret' })).rejects.toMatchObject({
			code: 'SECURE_STORAGE_UNAVAILABLE',
		})
		expect(await readFile(path, 'utf8')).toBe(before)
		await store.save({ ...input, secret: 'replacement-secret', rememberSecret: false })
		expect(store.getForBackend(input.id).secret).toBe('replacement-secret')
		expect(await readFile(path, 'utf8')).not.toContain('encryptedSecret')
		expect(await readFile(path, 'utf8')).not.toContain('replacement-secret')
	})
	it('keeps session credentials out of disk and public DTOs', async () => {
		const path = join(directory, 'workspace.json')
		const store = new WorkspaceStore(path, protection)
		await store.load()
		const input = profile()
		const result = await store.save(input)
		expect(result[0].secretState).toBe('session')
		expect(JSON.stringify(result)).not.toContain(input.secret)
		expect(await readFile(path, 'utf8')).not.toContain(input.secret)
		expect(store.getForBackend(input.id).secret).toBe(input.secret)
		const reopened = new WorkspaceStore(path, protection)
		await reopened.load()
		expect(reopened.list()[0].secretState).toBe('none')
		expect(() => reopened.getForBackend(input.id)).toThrow('Re-enter')
	})
	it('uses the protector, survives reload and removes the stored credential', async () => {
		const path = join(directory, 'workspace.json')
		const store = new WorkspaceStore(path, protection)
		const input = { ...profile(), rememberSecret: true }
		await store.save(input)
		const reopened = new WorkspaceStore(path, protection)
		await reopened.load()
		expect(reopened.list()[0].secretState).toBe('protected')
		expect(reopened.getForBackend(input.id).secret).toBe(input.secret)
		await reopened.remove(input.id)
		expect(await readFile(path, 'utf8')).not.toContain('encryptedSecret')
	})
	it('refuses persistence without secure storage but permits session-only use', async () => {
		const store = new WorkspaceStore(join(directory, 'workspace.json'), {
			...protection,
			available: () => false,
		})
		const input = profile()
		await expect(store.save({ ...input, rememberSecret: true })).rejects.toMatchObject({
			code: 'SECURE_STORAGE_UNAVAILABLE',
		})
		expect(store.list()).toHaveLength(0)
		await store.save(input)
		expect(store.list()[0].secretState).toBe('session')
		expect(secureStorageAvailable('linux', true, 'basic_text')).toBe(false)
		expect(secureStorageAvailable('linux', true, 'unknown')).toBe(false)
		expect(secureStorageAvailable('linux', true, 'gnome_libsecret')).toBe(true)
	})
	it('serializes concurrent writes without losing profiles or preferences', async () => {
		const path = join(directory, 'workspace.json')
		const store = new WorkspaceStore(path, protection)
		await Promise.all([store.save(profile()), store.save(profile()), store.setTheme('dark')])
		const reopened = new WorkspaceStore(path, protection)
		await reopened.load()
		expect(reopened.list()).toHaveLength(2)
		expect(reopened.theme).toBe('dark')
	})
	it('preserves unsupported workspace versions instead of overwriting them', async () => {
		const path = join(directory, 'workspace.json')
		await writeFile(path, '{"version":99}')
		await expect(new WorkspaceStore(path, protection).load()).rejects.toMatchObject({
			code: 'WORKSPACE_INVALID',
		})
		expect(await readFile(path, 'utf8')).toBe('{"version":99}')
	})
})
describe('renderer allowlist', () => {
	it('accepts only the local entry point or the configured development origin', () => {
		expect(trustedRendererUrl('commander://app/index.html')).toBe(true)
		for (const url of [
			'https://evil.test',
			'commander://evil/index.html',
			'commander://app/other.html',
			'file:///index.html',
			'invalid',
		])
			expect(trustedRendererUrl(url)).toBe(false)
		expect(trustedRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
		expect(trustedRendererUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
	})
})

it('keeps legacy Event Grid placeholders editable without unlocking secrets and enforces the new contract on save', async () => {
	const path = join(directory, 'workspace.json'),
		old = { ...profile(), service: 'event-grid' as const }
	delete old.secret
	await writeFile(
		path,
		JSON.stringify({ version: 1, theme: 'system', profiles: [{ profile: old }] }),
	)
	const available = vi.fn(() => {
		throw new Error('No implicit unlock')
	})
	const store = new WorkspaceStore(path, { ...protection, available })
	await store.load()
	expect(store.list()[0].id).toBe(old.id)
	expect(available).not.toHaveBeenCalled()
	await expect(store.save(old)).rejects.toThrow()
	await store.save({
		...old,
		namespace: 'unit.westeurope-1.eventgrid.azure.net',
		auth: 'device-code',
		tenantId: 'fixture',
		clientId: randomUUID(),
	})
	expect(store.list()[0].auth).toBe('device-code')
})
