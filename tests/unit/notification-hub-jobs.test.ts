import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Backend } from '../../src/main/platform/backend'
import {
	jobTypes,
	nhJobDraftSchema,
	nhJobGetSchema,
	nhJobSubmitSchema,
	storageSasError,
} from '../../src/shared/contracts/notification-hubs/jobs'
const dll = resolve('tests/MsgCommander.TestHost/bin/Debug/net10.0/MsgCommander.TestHost.dll')
let host: Backend
const sas = (output = true) =>
	`https://fixturestore.blob.core.windows.net/registrations${output ? '' : '/input.txt'}?sv=2025-01-05&sr=${output ? 'c' : 'b'}&sp=${output ? 'rwl' : 'r'}&se=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}&spr=https&sig=SECRET-STORAGE-SAS`
const draft = () => ({
	type: 'ExportRegistrations' as const,
	importFileUri: null,
	outputContainerUri: sas(),
})
async function start(hubName = 'alerts') {
	host = new Backend('dotnet', [dll])
	await host.start()
	const profile = {
		id: randomUUID(),
		name: 'Job fixture',
		service: 'notification-hubs',
		namespace: 'fixture.servicebus.windows.net',
		auth: 'sas',
		tenantId: '',
		clientId: '',
		rememberSecret: false,
		secret: 'Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;',
	}
	return (
		await host.request('nh.registrations.connect', {
			request: {
				id: randomUUID(),
				profileId: profile.id,
				hubName,
				source: 'profile',
				managementConnectionId: null,
				policyTarget: null,
				keyType: null,
			},
			profile,
		} as never)
	).connectionId
}
afterEach(async () => {
	await host?.stop()
})
it('checks production wire serialization, SAS redaction, all job types, receipts, rejection, cancellation, lost responses and bounded parsing', () => {
	expect(execFileSync('dotnet', [dll, '--nh-jobs-checks'], { encoding: 'utf8' })).toContain(
		'bulk job checks passed',
	)
})
it('validates the selected action, Storage permissions, input/output shape, signed URL expiry and explicit acknowledgment', () => {
	for (const type of jobTypes)
		expect(
			nhJobDraftSchema.safeParse({
				...draft(),
				type,
				importFileUri: type === 'ExportRegistrations' ? null : sas(false),
			}).success,
		).toBe(true)
	expect(nhJobDraftSchema.safeParse({ ...draft(), importFileUri: sas(false) }).success).toBe(
		false,
	)
	expect(
		nhJobDraftSchema.safeParse({ ...draft(), type: 'ImportDeleteRegistrations' }).success,
	).toBe(false)
	for (const value of [
		sas().replace('https:', 'http:'),
		sas().replace('blob.core.windows.net', 'evil.invalid'),
		sas().replace('sp=rwl', 'sp=r'),
		sas().replace('sr=c', 'sr=b'),
		sas() + '&sig=second',
		sas() + '#fragment',
		sas().replace('sig=SECRET-STORAGE-SAS', 'sig='),
		sas().replace('se=', 'se=invalid'),
		sas().replace('/registrations?', '/registrations/input.txt?'),
		sas().replace('fixturestore.blob.core.windows.net', 'localhost'),
		sas().replace('spr=https', 'spr=http'),
	])
		expect(storageSasError(value, true)).toBeTruthy()
	expect(storageSasError(sas(false).replace('sp=r', 'sp=w'), false)).toBeTruthy()
	expect(
		nhJobGetSchema.safeParse({ id: randomUUID(), connectionId: randomUUID(), jobId: '../jobs' })
			.success,
	).toBe(false)
	expect(
		nhJobSubmitSchema.safeParse({
			id: randomUUID(),
			connectionId: randomUUID(),
			reviewId: randomUUID(),
			acknowledge: false,
		}).success,
	).toBe(false)
})
it('uses private reviewed URLs once, exposes sanitized results, and recovers by Azure ID after reconnect', async () => {
	let connectionId = await start()
	const req = () => ({ id: randomUUID(), connectionId })
	const review = await host.request('nh.registrations.jobs.preview', { ...req(), draft: draft() })
	expect(JSON.stringify(review)).not.toContain('SECRET')
	const request = { ...req(), reviewId: review.reviewId, acknowledge: true as const }
	const outcome = await host.request('nh.registrations.jobs.submit', request)
	expect(outcome.status).toBe('accepted')
	expect(outcome.job?.status).toBe('Running')
	expect(JSON.stringify(outcome)).not.toContain('SECRET')
	expect(await host.request('nh.registrations.jobs.submit', request)).toEqual(outcome)
	expect(
		await host.request('nh.registrations.jobs.result', { ...req(), operationId: request.id }),
	).toEqual(outcome)
	expect(
		(await host.request('nh.registrations.jobs.get', { ...req(), jobId: outcome.job!.jobId }))
			.status,
	).toBe('Completed')
	await host.request('nh.registrations.reset', {})
	await expect(host.request('nh.registrations.jobs.list', req())).rejects.toThrow('expired')
	// Existing Azure jobs remain discoverable independently of local operation receipts.
	await host.stop()
	connectionId = await start()
	expect(
		(await host.request('nh.registrations.jobs.get', { ...req(), jobId: 'existing-job' }))
			.status,
	).toBe('Completed')
})
it('returns a recoverable uncertain receipt when a submitted job loses its response', async () => {
	const connectionId = await start('job-uncertain'),
		req = () => ({ id: randomUUID(), connectionId })
	const review = await host.request('nh.registrations.jobs.preview', { ...req(), draft: draft() })
	const request = { ...req(), reviewId: review.reviewId, acknowledge: true as const }
	const outcome = await host.request('nh.registrations.jobs.submit', request)
	expect(outcome.status).toBe('unknown')
	expect((await host.request('nh.registrations.jobs.list', req())).items).toHaveLength(2)
	expect(
		await host.request('nh.registrations.jobs.result', { ...req(), operationId: request.id }),
	).toEqual(outcome)
})
