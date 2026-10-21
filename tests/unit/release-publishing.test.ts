import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { version } from '../../package.json'

let directory: string
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'msg-release-'))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
const targets = [
	['darwin-arm64', 'latest-mac.yml', ['mac-arm64.zip', 'mac-arm64.dmg']],
	['darwin-x64', 'latest-mac.yml', ['mac-x64.zip', 'mac-x64.dmg']],
	['linux-x64', 'latest-linux.yml', ['linux-x64.AppImage']],
	['win32-x64', 'latest.yml', ['win-x64.exe']],
] as const
async function packages() {
	for (const [target, manifest, suffixes] of targets) {
		const path = join(directory, 'input', `Msg-Commander-${target}`)
		await mkdir(path, { recursive: true })
		const files = []
		for (const suffix of suffixes) {
			const url = `Msg-Commander-${version}-${suffix}`
			const bytes = Buffer.from(`Package fixture ${suffix}`)
			await writeFile(join(path, url), bytes)
			files.push({
				url,
				sha512: createHash('sha512').update(bytes).digest('base64'),
				size: bytes.length,
			})
		}
		await writeFile(join(path, manifest), stringify({ version, files }))
	}
}
function prepare(tag = `v${version}`) {
	return execFileSync(
		process.execPath,
		[
			resolve('scripts/prepare-release.mjs'),
			join(directory, 'input'),
			join(directory, 'output'),
		],
		{
			env: { ...process.env, GITHUB_REF_NAME: tag },
			stdio: 'pipe',
		},
	)
}
it('publishes both Mac architectures in one manifest alongside Windows and Linux packages', async () => {
	await packages()
	prepare()
	const names = await readdir(join(directory, 'output'))
	expect(names).toHaveLength(9)
	const mac = parse(await readFile(join(directory, 'output', 'latest-mac.yml'), 'utf8'))
	expect(mac.files).toHaveLength(4)
	expect(mac.files.map((file: { url: string }) => file.url)).toEqual(
		expect.arrayContaining([
			`Msg-Commander-${version}-mac-arm64.zip`,
			`Msg-Commander-${version}-mac-x64.zip`,
		]),
	)
})
it('refuses a release if any platform is missing or a package checksum changes', async () => {
	await packages()
	const artifact = join(
		directory,
		'input',
		'Msg-Commander-win32-x64',
		`Msg-Commander-${version}-win-x64.exe`,
	)
	await writeFile(artifact, 'corrupted')
	expect(() => prepare()).toThrow()
	await packages()
	await rm(artifact)
	expect(() => prepare()).toThrow()
})
it('refuses mismatched tags and manifest versions', async () => {
	await packages()
	expect(() => prepare('v0.0.0')).toThrow()
	const path = join(directory, 'input', 'Msg-Commander-linux-x64', 'latest-linux.yml')
	const manifest = parse(await readFile(path, 'utf8'))
	await writeFile(path, stringify({ ...manifest, version: '0.0.0' }))
	expect(() => prepare()).toThrow()
})

it('accepts builder manifests without optional sizes and fills in verified byte lengths', async () => {
	await packages()
	const path = join(directory, 'input', 'Msg-Commander-darwin-arm64', 'latest-mac.yml')
	const manifest = parse(await readFile(path, 'utf8'))
	for (const file of manifest.files) delete file.size
	await writeFile(path, stringify(manifest))
	prepare()
	const combined = parse(await readFile(join(directory, 'output', 'latest-mac.yml'), 'utf8'))
	expect(combined.files.every((file: { size: number }) => file.size > 0)).toBe(true)
})
