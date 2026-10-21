import { useWorkspace } from '@/shared/workspace/store'
import { defineStore } from 'pinia'
import { createRegistrationBrowsing } from '../composables/registrations/browsing'
import { createRegistrationFiles } from '../composables/registrations/files'
import { createRegistrationJobs } from '../composables/registrations/jobs'
import { createRegistrationLifecycle } from '../composables/registrations/lifecycle'
import { createRegistrationMutations } from '../composables/registrations/mutations'
import { createRegistrationTasks } from '../composables/registrations/tasks'
import type { RegistrationActions } from '../model/registration-actions'
import { createRegistrationState } from '../model/registrations-state'
export const useNotificationHubRegistrations = defineStore('notification-hub-registrations', () => {
	const workspace = useWorkspace(),
		state = createRegistrationState()
	const {
		connection,
		busy,
		operationId,
		error,
		page,
		details,
		query,
		editor,
		outcome,
		reviewed,
		filePreview,
		fileName,
		fileDetails,
		fileOutcome,
		fileReviewed,
		jobReview,
		jobOutcome,
		jobPage,
		selectedJob,
		jobReviewed,
		blocked,
		pageNumber,
	} = state
	const actions: RegistrationActions = {
		task: (...args) => tasks.task(...args),
		search: (...args) => browsing.search(...args),
		reset: () => lifecycle.reset(),
	}
	const tasks = createRegistrationTasks(state, workspace)
	const { task } = tasks
	const lifecycle = createRegistrationLifecycle(state, actions, workspace)
	const { reset, connect, disconnect, cancel } = lifecycle
	const browsing = createRegistrationBrowsing(state, actions)
	const { search, next, previous, inspect, refreshInspection } = browsing
	const mutations = createRegistrationMutations(state, actions)
	const { openEditor, reloadEditor, change, recover, closeEditor } = mutations
	const files = createRegistrationFiles(state, actions)
	const { importFile, inspectFile, exportFile, applyFile, recoverFile } = files
	const jobs = createRegistrationJobs(state, actions)
	const { listJobs, getJob, previewJob, discardJob, submitJob, recoverJob } = jobs
	return {
		jobReview,
		jobOutcome,
		jobPage,
		selectedJob,
		jobReviewed,
		listJobs,
		getJob,
		previewJob,
		discardJob,
		submitJob,
		recoverJob,
		filePreview,
		fileName,
		fileDetails,
		fileOutcome,
		fileReviewed,
		importFile,
		inspectFile,
		exportFile,
		applyFile,
		recoverFile,
		refreshInspection,
		editor,
		outcome,
		reviewed,
		blocked,
		openEditor,
		reloadEditor,
		change,
		recover,
		closeEditor,
		connection,
		busy,
		error,
		operationId,
		page,
		details,
		query,
		pageNumber,
		reset,
		task,
		connect,
		disconnect,
		search,
		next,
		previous,
		inspect,
		cancel,
	}
})
