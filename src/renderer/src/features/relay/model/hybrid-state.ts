import type { HybridProgress, HybridResult, HybridRun } from '@shared/contracts/relay/hybrid'
import { ref } from 'vue'
export type HybridEntry = {
	id: string
	request: HybridRun
	running: boolean
	result?: HybridResult
	progress?: HybridProgress
	error: string
	interrupted: boolean
	reviewed: boolean
}
export function createHybridState() {
	const entries = ref<HybridEntry[]>([]),
		lifetime = { generation: 0 }
	function reset() {
		lifetime.generation++
		entries.value = []
	}
	function receive(event: HybridProgress) {
		const entry = entries.value.find((e) => e.id === event.operationId)
		if (entry?.running) entry.progress = event
	}
	function blocked(kind: 'send' | 'listen') {
		return entries.value.some(
			(e) =>
				(e.running && e.request.mode.endsWith(kind)) ||
				e.result?.cleanupWarning ||
				((e.interrupted || e.result?.status === 'unknown') && !e.reviewed),
		)
	}
	return { entries, lifetime, reset, receive, blocked }
}
export type HybridState = ReturnType<typeof createHybridState>
