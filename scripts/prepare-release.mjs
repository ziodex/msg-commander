import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse, stringify } from 'yaml'

const targets = [
	['darwin-arm64', 'latest-mac.yml', ['mac-arm64.dmg', 'mac-arm64.zip']],
	['darwin-x64', 'latest-mac.yml', ['mac-x64.dmg', 'mac-x64.zip']],
	['linux-x64', 'latest-linux.yml', ['linux-x64.AppImage']],
	['win32-x64', 'latest.yml', ['win-x64.exe']],
]

export async function prepareRelease(input, output, version) {
	const manifests = new Map()
	const packages = new Map()
	for (const [target, manifestName, suffixes] of targets) {
		const directory = join(input, `Msg-Commander-${target}`)
		const names = await readdir(directory)
		for (const suffix of suffixes)
			if (!names.includes(`Msg-Commander-${version}-${suffix}`))
				throw new Error(`Missing ${target} package: ${suffix}`)
		const manifest = parse(await readFile(join(directory, manifestName), 'utf8'))
		if (
			manifest.version !== version ||
			!Array.isArray(manifest.files) ||
			!manifest.files.length
		)
			throw new Error(`Invalid update manifest for ${target}`)
		const updateSuffix = suffixes.find((suffix) => !suffix.endsWith('.dmg'))
		if (!manifest.files.some((file) => file.url === `Msg-Commander-${version}-${updateSuffix}`))
			throw new Error(`Missing installable update in the manifest for ${target}`)
		for (const file of manifest.files) {
			if (
				typeof file.url !== 'string' ||
				basename(file.url) !== file.url ||
				!suffixes.some((suffix) => file.url === `Msg-Commander-${version}-${suffix}`)
			)
				throw new Error(`Unexpected update artifact for ${target}`)
			const bytes = await readFile(join(directory, file.url))
			if (
				createHash('sha512').update(bytes).digest('base64') !== file.sha512 ||
				(file.size !== undefined && bytes.length !== file.size)
			)
				throw new Error(`Package integrity check failed: ${file.url}`)
			file.size = bytes.length
		}
		const previous = manifests.get(manifestName)
		if (previous) previous.files.push(...manifest.files)
		else manifests.set(manifestName, manifest)
		for (const name of names.filter((name) =>
			/\.(dmg|zip|exe|AppImage|blockmap)$/.test(name),
		)) {
			if (!name.startsWith(`Msg-Commander-${version}-`) || packages.has(name))
				throw new Error(`Unexpected or duplicate release artifact: ${name}`)
			packages.set(name, join(directory, name))
		}
	}
	await mkdir(output, { recursive: true })
	if ((await readdir(output)).length) throw new Error('Release output must be empty.')
	for (const [name, path] of packages) await copyFile(path, join(output, name))
	for (const [name, manifest] of manifests) {
		manifest.files.sort((a, b) => a.url.localeCompare(b.url))
		await writeFile(join(output, name), stringify(manifest))
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { version } = JSON.parse(
		await readFile(new URL('../package.json', import.meta.url), 'utf8'),
	)
	if (process.env.GITHUB_REF_NAME !== `v${version}`)
		throw new Error('Release tag does not match package.json.')
	await prepareRelease(process.argv[2], process.argv[3], version)
}
