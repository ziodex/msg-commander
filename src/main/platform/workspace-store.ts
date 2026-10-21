import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
	profileInputSchema,
	themeSchema,
	type Profile,
	type ProfileInput,
	type Theme,
} from '../../shared/contracts'
import { HostError } from './backend'
import {
	preferencesSchema,
	defaultPreferences,
	type Preferences,
	type PreferenceState,
} from '../../shared/application-settings'

const storedProfileSchema = z
	.object({
		// Pre-discovery Event Grid placeholders used the generic profile form.
		// Keep them editable; new saves and connects enforce the namespace/Entra contract.
		profile: profileInputSchema
			.or(
				z
					.object({ ...profileInputSchema.shape, service: z.literal('event-grid') })
					.strict(),
			)
			.transform(({ secret: _secret, rememberSecret: _remember, ...profile }) => profile),
		encryptedSecret: z.string().max(32768).optional(),
	})
	.strict()
const legacyWorkspaceSchema = z
	.object({
		version: z.literal(1),
		theme: themeSchema,
		profiles: z.array(storedProfileSchema).max(100),
	})
	.strict()
const workspaceSchema = legacyWorkspaceSchema
	.extend({
		version: z.literal(2),
		preferences: preferencesSchema,
		preferenceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		settingsMigrations: z
			.array(
				z
					.object({
						fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
						appliedAt: z.iso.datetime(),
						changed: z.number().int().min(0).max(6),
					})
					.strict(),
			)
			.max(64),
	})
	.strict()
type Workspace = z.infer<typeof workspaceSchema>
export interface SecretProtection {
	available(): boolean
	encrypt(value: string): Buffer
	decrypt(value: Buffer): string
}

export class WorkspaceStore {
	private data: Workspace = {
		version: 2,
		theme: 'system',
		profiles: [],
		preferences: { ...defaultPreferences },
		preferenceRevision: 0,
		settingsMigrations: [],
	}
	private preferencesStored = false
	private secrets = new Map<string, string>()
	private queue: Promise<unknown> = Promise.resolve()
	constructor(
		private readonly path: string,
		private readonly protection: SecretProtection,
	) {}
	async load() {
		try {
			const input = JSON.parse(await readFile(this.path, 'utf8'))
			if (input?.version === 1) {
				const legacy = legacyWorkspaceSchema.parse(input)
				this.data = {
					...legacy,
					version: 2,
					preferences: { ...defaultPreferences },
					preferenceRevision: 0,
					settingsMigrations: [],
				}
				this.preferencesStored = false
			} else {
				this.data = workspaceSchema.parse(input)
				this.preferencesStored = true
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw new HostError(
					'WORKSPACE_INVALID',
					'Workspace could not be read. Keep the original file and restore a valid version before continuing.',
				)
		}
	}
	get theme() {
		return this.data.theme
	}
	get preferenceState(): PreferenceState {
		return {
			preferences: { ...this.data.preferences },
			revision: this.data.preferenceRevision,
			stored: this.preferencesStored,
			migrations: this.data.settingsMigrations.map((m) => ({ ...m })),
		}
	}
	savePreferences(preferences: Preferences, revision: number) {
		const parsed = preferencesSchema.parse(preferences)
		return this.transact(async () => {
			if (this.data.preferenceRevision !== revision)
				throw new HostError(
					'SETTINGS_STALE',
					'Preferences changed. Close and reopen Preferences before saving again.',
				)
			await this.persist({
				...this.data,
				preferences: parsed,
				preferenceRevision: revision + 1,
			})
			return this.preferenceState
		})
	}
	// Accessing the OS store can wait for a native permission prompt. Call only
	// when saving a remembered credential or explicitly connecting with one.
	private get secureStorage() {
		return this.protection.available()
	}
	list(): Profile[] {
		return this.data.profiles.map(({ profile, encryptedSecret }) => ({
			...profile,
			// This describes persisted ciphertext, not whether the store is unlocked.
			// Listing metadata must never probe the credential store.
			secretState: encryptedSecret
				? 'protected'
				: this.secrets.has(profile.id)
					? 'session'
					: 'none',
		}))
	}
	private transact<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(action)
		this.queue = result.catch(() => {})
		return result
	}
	async flush() {
		await this.queue
	}
	private async persist(next: Workspace) {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
		const temporary = `${this.path}.tmp`
		await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
		await rename(temporary, this.path)
		this.data = next
		this.preferencesStored = true
	}
	save(input: ProfileInput): Promise<Profile[]> {
		return this.transact(async () => {
			const { secret, rememberSecret, ...profile } = profileInputSchema.parse(input)
			const existing = this.data.profiles.find((item) => item.profile.id === profile.id)
			if (!existing && this.data.profiles.length >= 100)
				throw new HostError('LIMIT', 'A workspace supports up to 100 profiles.')
			if (profile.auth === 'sas' && !secret && !existing)
				throw new HostError('CREDENTIAL_REQUIRED', 'Enter a namespace connection string.')
			let encryptedSecret: string | undefined
			if (profile.auth === 'sas' && secret && rememberSecret) {
				if (!this.secureStorage)
					throw new HostError(
						'SECURE_STORAGE_UNAVAILABLE',
						'Secure storage is unavailable. Use session-only credentials.',
					)
				encryptedSecret = this.protection.encrypt(secret).toString('base64')
			}
			await this.persist({
				...this.data,
				profiles: [
					...this.data.profiles.filter((item) => item.profile.id !== profile.id),
					{ profile, encryptedSecret },
				],
			})
			this.secrets.delete(profile.id)
			if (profile.auth === 'sas' && secret && !rememberSecret)
				this.secrets.set(profile.id, secret)
			return this.list()
		})
	}
	remove(id: string): Promise<Profile[]> {
		return this.transact(async () => {
			await this.persist({
				...this.data,
				profiles: this.data.profiles.filter((item) => item.profile.id !== id),
			})
			this.secrets.delete(id)
			return this.list()
		})
	}
	setTheme(theme: Theme) {
		return this.transact(async () => {
			await this.persist({ ...this.data, theme })
		})
	}
	getForBackend(id: string): ProfileInput {
		const entry = this.data.profiles.find((item) => item.profile.id === id)
		if (!entry) throw new HostError('NOT_FOUND', 'Connection profile no longer exists.')
		let secret = this.secrets.get(id)
		if (entry.encryptedSecret) {
			if (!this.secureStorage)
				throw new HostError(
					'SECURE_STORAGE_UNAVAILABLE',
					'Unlock your OS credential store or re-enter the connection string.',
				)
			try {
				secret = this.protection.decrypt(Buffer.from(entry.encryptedSecret, 'base64'))
			} catch {
				throw new HostError(
					'CREDENTIAL_LOCKED',
					'The saved credential could not be unlocked. Re-enter it in the connection settings.',
				)
			}
		}
		if (entry.profile.auth === 'sas' && !secret)
			throw new HostError(
				'CREDENTIAL_REQUIRED',
				'Re-enter the session-only connection string in connection settings.',
			)
		return { ...entry.profile, secret, rememberSecret: false }
	}
}
