import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper'

const require = createRequire(import.meta.url)
const temp = require('temp')
let directory: string

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'msg-dependencies-'))
})
afterEach(async () => {
	temp.cleanupSync()
	await rm(directory, { recursive: true, force: true })
})

it('reuses a downloaded update only when both metadata records and the file still match', async () => {
	const file = join(directory, 'update.exe')
	await writeFile(file, 'downloaded update')
	const info = { url: 'update.exe', sha512: 'original-checksum', size: 17 }
	const update = {
		version: '0.64.0',
		files: [info],
		path: info.url,
		sha512: info.sha512,
		releaseDate: '2026-10-21T00:00:00Z',
		releaseNotes: [{ version: '0.64.0', note: 'Update fixture' }],
	}
	const fileInfo = { url: new URL('https://example.invalid/update.exe'), info }
	const helper = new DownloadedUpdateHelper(directory)
	const logger = { info() {}, warn() {}, error() {} }
	await helper.setDownloadedFile(file, null, update, fileInfo, 'update.exe', false)

	expect(
		await helper.validateDownloadedPath(
			file,
			structuredClone(update),
			{ ...fileInfo, info: { ...info } },
			logger,
		),
	).toBe(file)
	expect(
		await helper.validateDownloadedPath(
			file,
			{ ...update, version: '0.65.0' },
			fileInfo,
			logger,
		),
	).toBeNull()
	expect(
		await helper.validateDownloadedPath(
			file,
			update,
			{ ...fileInfo, info: { ...info, sha512: 'different-checksum' } },
			logger,
		),
	).toBeNull()
	await rm(file)
	expect(await helper.validateDownloadedPath(file, update, fileInfo, logger)).toBeNull()
})

it.each(['async', 'sync'])('cleans tracked temporary files and directories (%s)', async (mode) => {
	temp.track()
	const folder = temp.mkdirSync({ dir: directory, prefix: 'folder [literal] ' })
	await mkdir(join(folder, 'nested'))
	await writeFile(join(folder, 'nested', 'file.txt'), 'temporary')
	const file = temp.openSync({ dir: directory, prefix: 'file [literal] ' })
	closeSync(file.fd)
	const missing = temp.mkdirSync({ dir: directory, prefix: 'already-removed-' })
	await rm(missing, { recursive: true })
	const preserved = join(directory, 'preserved.txt')
	await writeFile(preserved, 'keep')

	const result = mode === 'sync' ? temp.cleanupSync() : await temp.cleanup()
	expect(result).toEqual({ files: 1, dirs: 2 })
	await expect(readFile(file.path)).rejects.toMatchObject({ code: 'ENOENT' })
	await expect(readFile(join(folder, 'nested', 'file.txt'))).rejects.toMatchObject({
		code: 'ENOENT',
	})
	expect(await readFile(preserved, 'utf8')).toBe('keep')
})

it('creates ASAR archives readable by electron-builder and the Mac universal helper', async () => {
	const asar = await import('@electron/asar')
	const { checkFileInArchive } = require('app-builder-lib/out/asar/asarFileChecker')
	const { generateAsarIntegrity } = require('@electron/universal/dist/cjs/asar-utils')
	const source = join(directory, 'app')
	const archive = join(directory, 'app.asar')
	await mkdir(source)
	await writeFile(join(source, 'index.js'), 'module.exports = 42\n')
	await writeFile(join(source, 'native.node'), 'unpacked fixture')
	await asar.createPackageWithOptions(source, archive, { unpack: '*.node' })

	expect(asar.extractFile(archive, 'index.js').toString()).toBe('module.exports = 42\n')
	expect(await readFile(`${archive}.unpacked/native.node`, 'utf8')).toBe('unpacked fixture')
	await expect(checkFileInArchive(archive, 'index.js', 'Entry point')).resolves.toMatchObject({
		size: 20,
	})
	expect(generateAsarIntegrity(archive)).toEqual({
		algorithm: 'SHA256',
		hash: createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex'),
	})
})
