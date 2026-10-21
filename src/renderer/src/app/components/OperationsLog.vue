<script setup lang="ts">
import { platformApi } from '@/shared/platform/api'

import { computed, ref, watch } from 'vue'
import { Activity, ArrowRight, Check, CircleHelp, Terminal, X } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { useWorkspace } from '@/shared/workspace/store'
import type { OperationLogRequest } from '@shared/desktop-tools'
const store = useWorkspace()
const chosen = ref(new Set<string>()),
	exporting = ref(false),
	notice = ref(''),
	error = ref('')
const allSelected = computed(
	() => !!store.jobs.length && store.jobs.every((job) => chosen.value.has(job.id)),
)
const exportEntries = computed((): OperationLogRequest['entries'] =>
	store.jobs
		.filter((job) => !chosen.value.size || chosen.value.has(job.id))
		.slice(0, 500)
		.map((job) => ({
			id: job.id,
			timestamp: job.startedAt ?? new Date().toISOString(),
			label: job.label.slice(0, 1024),
			status: job.status,
			message: job.message.slice(0, 8192),
		})),
)
watch(
	() => store.jobs.map((job) => job.id),
	(ids) => {
		chosen.value = new Set([...chosen.value].filter((id) => ids.includes(id)))
	},
)
function toggle(id: string) {
	const next = new Set(chosen.value)
	if (next.has(id)) next.delete(id)
	else next.add(id)
	chosen.value = next
}
function selectAll() {
	chosen.value = allSelected.value ? new Set() : new Set(store.jobs.map((job) => job.id))
}
function clearSelected() {
	store.jobs = store.jobs.filter((job) => job.status === 'running' || !chosen.value.has(job.id))
	chosen.value = new Set()
}
async function exportLog(destination: 'clipboard' | 'file') {
	exporting.value = true
	notice.value = ''
	error.value = ''
	try {
		const result = store.unwrapResult(
			await platformApi.exportOperationLog({ destination, entries: exportEntries.value }),
		)
		if (!result.cancelled)
			notice.value =
				destination === 'clipboard' ? 'Log copied.' : 'Saved ' + result.fileName + '.'
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Log could not be exported.'
	} finally {
		exporting.value = false
	}
}
async function openDeviceLogin() {
	const result = await platformApi.openDeviceLogin()
	if (!result.ok) store.error = result.error.message
}
</script>
<template>
	<section class="operations-panel" aria-label="Operations">
		<header>
			<div>
				<input
					type="checkbox"
					aria-label="Select all log entries"
					:checked="allSelected"
					:disabled="!store.jobs.length"
					@change="selectAll"
				/>
				<Terminal :size="15" />
				<h2>Operations</h2>
				<span class="count">{{ store.running }}</span
				><span v-if="store.running" class="running-label">running</span>
			</div>
			<div class="log-actions">
				<button
					:disabled="!exportEntries.length || exporting"
					@click="exportLog('clipboard')"
				>
					{{ chosen.size ? 'Copy selected' : 'Copy log' }}
				</button>
				<button :disabled="!exportEntries.length || exporting" @click="exportLog('file')">
					{{ chosen.size ? 'Save selected…' : 'Save log…' }}
				</button>
				<button v-if="chosen.size" @click="clearSelected">Clear selected</button>
				<button
					v-if="store.jobs.some((job) => job.status !== 'running')"
					@click="store.jobs = store.jobs.filter((job) => job.status === 'running')"
				>
					Clear completed
				</button>
			</div>
		</header>
		<p v-if="notice" role="status" class="log-notice">{{ notice }}</p>
		<p v-if="error" role="alert" class="log-notice">{{ error }}</p>
		<div class="jobs-list" aria-live="polite">
			<div v-if="!store.jobs.length" class="jobs-empty">
				<div><Check :size="17" /></div>
				<p>No operations running</p>
			</div>
			<article v-for="job in store.jobs" :key="job.id" class="job-row">
				<input
					type="checkbox"
					:aria-label="'Select log entry ' + job.label"
					:checked="chosen.has(job.id)"
					@change="toggle(job.id)"
				/>
				<div class="job-indicator" :class="job.status">
					<Activity v-if="job.status === 'running'" :size="16" /><Check
						v-else-if="job.status === 'completed'"
						:size="16"
					/><CircleHelp
						v-else-if="job.status === 'accepted' || job.status === 'unknown'"
						:size="16"
					/><X v-else :size="16" />
				</div>
				<div class="job-body">
					<div>
						<time :datetime="job.startedAt">{{
							job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : ''
						}}</time>
						<strong>{{ job.label }}</strong
						><Badge variant="outline">{{ job.status }}</Badge>
					</div>
					<p>{{ job.message }}</p>
					<div v-if="job.code" class="device-code">
						<code>{{ job.code }}</code
						><Button variant="outline" size="sm" @click="openDeviceLogin()"
							>Open Microsoft sign-in<ArrowRight /></Button
						><small>Expires {{ new Date(job.expiresOn!).toLocaleTimeString() }}</small>
					</div>
					<progress
						v-if="job.status === 'running' && !job.code"
						:value="job.percent"
						max="100"
						:aria-label="job.label"
					/>
				</div>
				<Button
					v-if="job.status === 'running'"
					variant="ghost"
					size="sm"
					@click="store.cancel(job.id)"
					>Cancel</Button
				>
			</article>
		</div>
	</section>
</template>
