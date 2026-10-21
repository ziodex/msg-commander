import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationIdentity } from '../../src/main/platform/application-identity'

let directory: string
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'msg-commander-identity-'))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
async function workspace(name: string) {
	const path = join(directory, name)
	await mkdir(path, { recursive: true })
	await writeFile(join(path, 'workspace.json'), '{"encryptedSecret":"unchanged"}')
	return path
}

it('uses the new profile and encryption identity for a fresh installation', () => {
	expect(applicationIdentity(directory)).toEqual({
		userData: join(directory, 'Msg Commander'),
		storageName: 'Msg Commander',
	})
})
it('preserves the previous profile and encryption identity without rewriting its contents', async () => {
	const path = await workspace('Service Bus Commander')
	expect(applicationIdentity(directory)).toEqual({
		userData: path,
		storageName: 'Service Bus Commander',
	})
	expect(await readFile(join(path, 'workspace.json'), 'utf8')).toBe(
		'{"encryptedSecret":"unchanged"}',
	)
})
it('prefers an existing current workspace when both profiles exist', async () => {
	await workspace('Service Bus Commander')
	const path = await workspace('Msg Commander')
	expect(applicationIdentity(directory)).toEqual({ userData: path, storageName: 'Msg Commander' })
})
it('honors an explicit profile override without discovering another profile', async () => {
	await workspace('Service Bus Commander')
	const override = join(directory, 'isolated-test')
	expect(applicationIdentity(directory, override)).toEqual({
		userData: override,
		storageName: 'Msg Commander',
	})
})
