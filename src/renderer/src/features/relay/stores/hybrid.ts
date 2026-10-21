import { useWorkspace } from '@/shared/workspace/store'
import { defineStore } from 'pinia'
import { createHybridJobs } from '../composables/hybrid/jobs'
import { createHybridState } from '../model/hybrid-state'
export const useHybrid = defineStore('hybrid', () => {
	const state = createHybridState(),
		jobs = createHybridJobs(state, useWorkspace())
	const { entries, reset, receive, blocked } = state
	return { entries, reset, receive, blocked, ...jobs }
})
