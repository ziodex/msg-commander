import type {
	TestJobRequest,
	TestJobResultRequest,
	TestPayloadPreview,
} from '@shared/contracts/service-bus/test-jobs'

// The feature's only renderer dependency on the desktop bridge.
export const testJobsApi = {
	run: (request: TestJobRequest) => window.commander.runTestJob(request),
	result: (request: TestJobResultRequest) => window.commander.getTestJobResult(request),
	previewPayload: (request: TestPayloadPreview) => window.commander.previewTestPayload(request),
}
