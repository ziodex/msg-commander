import { platformApi } from '@/shared/platform/api'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
	defaultPreferences,
	type PreferenceState,
	type Preferences,
} from '@shared/application-settings'
import type {
	AppEvent,
	BackendStatus,
	Bootstrap,
	DesktopResult,
	Operation,
	Profile,
	ProfileInput,
	Service,
	Theme,
} from '@shared/contracts'

export const services: { id: Service; name: string; description: string; milestone: string }[] = [
	{
		id: 'service-bus',
		name: 'Service Bus',
		description: 'Queues, topics, subscriptions and messages.',
		milestone: 'Milestone 3',
	},
	{
		id: 'event-hubs',
		name: 'Event Hubs',
		description: 'Event streams, partitions and consumer groups.',
		milestone: 'Milestone 4',
	},
	{
		id: 'iot-hub',
		name: 'IoT Hub',
		description: 'Built-in device-to-cloud endpoint, partitions and listeners.',
		milestone: 'Milestone 4',
	},
	{
		id: 'relay',
		name: 'Relay',
		description: 'Relay management and Hybrid Connections.',
		milestone: 'Milestone 4',
	},
	{
		id: 'notification-hubs',
		name: 'Notification Hubs',
		description: 'Registrations, templates and test notifications.',
		milestone: 'Milestone 4',
	},
	{
		id: 'event-grid',
		name: 'Event Grid',
		description: 'Namespace topics, publishing and pull delivery.',
		milestone: 'Milestone 4',
	},
]
export type Job = {
	startedAt?: string
	id: string
	label: string
	status: 'running' | 'completed' | 'cancelled' | 'failed' | 'accepted' | 'unknown'
	percent: number | undefined
	progress?: Extract<AppEvent, { operationId: string }>
	percentOnCompletion?: number
	describeFailure?: (message?: string) => string
	cancel?: () => Promise<void>
	message: string
	code?: string
	expiresOn?: string
}
export const useWorkspace = defineStore('workspace', () => {
	const status = ref<BackendStatus>({
		state: 'starting',
		detail: 'Connecting to the desktop host…',
	})
	const profiles = ref<Profile[]>([])
	const theme = ref<Theme>('system')
	const preferenceState = ref<PreferenceState>({
		preferences: { ...defaultPreferences },
		revision: 0,
		stored: false,
		migrations: [],
	})
	const preferences = computed(() => preferenceState.value.preferences)
	const version = ref('0.63.0')
	const platform = ref('')
	const service = ref<Service>('service-bus')
	const selectedId = ref<string>()
	const jobs = ref<Job[]>([])
	const error = ref('')
	const selected = computed(() =>
		profiles.value.find((profile) => profile.id === selectedId.value),
	)
	const activeService = computed(() => services.find((item) => item.id === service.value)!)
	const ready = computed(() => status.value.state === 'ready')
	const running = computed(() => jobs.value.filter((job) => job.status === 'running').length)
	function unwrap<T>(result: DesktopResult<T>): T {
		if (!result.ok) throw new Error(result.error.message)
		return result.value
	}
	function receive(event: AppEvent) {
		if (event.type === 'backend') status.value = event.status
		if (event.type === 'progress' || event.type === 'device-code') {
			const job = jobs.value.find((item) => item.id === event.operationId)
			if (!job || job.status !== 'running') return
			if (event.type === 'progress') {
				job.percent = event.percent
				job.message = event.message
			} else {
				job.code = event.code
				job.expiresOn = event.expiresOn
				job.message = 'Enter this code at Microsoft’s device sign-in page.'
			}
		}
	}
	async function initialize() {
		try {
			const data: Bootstrap = unwrap(await platformApi.bootstrap())
			status.value = data.status
			profiles.value = data.profiles
			theme.value = data.theme
			version.value = data.version
			platform.value = data.platform
			if (data.preferenceState) preferenceState.value = data.preferenceState
			// Move the previous renderer-only count interval once. No legacy files are discovered.
			if (!preferenceState.value.stored) {
				let old: string | null = null
				try {
					old = localStorage.getItem('commander-count-interval')
				} catch {
					// Optional browser preference.
				}
				if (old !== null && [0, 10, 30, 60, 300].includes(Number(old))) {
					try {
						await savePreferences({
							...preferences.value,
							countRefreshSeconds: Number(old),
						})
					} catch {
						// Keep the old value for a later explicit save.
					}
				}
			}
		} catch (cause) {
			error.value = String(cause)
			status.value = { state: 'crashed', detail: 'Desktop bridge could not initialize.' }
		}
	}
	async function save(profile: ProfileInput) {
		profiles.value = unwrap(await platformApi.saveProfile(profile))
		selectedId.value = profile.id
		service.value = profile.service
	}
	async function remove(id: string) {
		try {
			profiles.value = unwrap(await platformApi.removeProfile(id))
			if (selectedId.value === id) selectedId.value = undefined
		} catch (cause) {
			error.value = String(cause)
		}
	}
	async function setTheme(next: Theme) {
		try {
			unwrap(await platformApi.setTheme(next))
			theme.value = next
		} catch (cause) {
			error.value = String(cause)
		}
	}
	function acceptPreferences(state: PreferenceState) {
		preferenceState.value = state
	}
	async function savePreferences(next: Preferences, revision = preferenceState.value.revision) {
		const state = unwrap(await platformApi.savePreferences({ preferences: next, revision }))
		acceptPreferences(state)
	}
	async function restart() {
		status.value = { state: 'starting', detail: 'Restarting the bundled backend…' }
		try {
			unwrap(await platformApi.restartBackend())
		} catch (cause) {
			error.value = String(cause)
		}
	}
	async function run(kind: Operation['kind'], profileId?: string) {
		const id = crypto.randomUUID()
		const operation: Operation =
			kind === 'diagnostics' ? { id, kind } : { id, kind, profileId: profileId! }
		const job: Job = {
			id,
			startedAt: new Date().toISOString(),
			label:
				kind === 'diagnostics'
					? 'Local diagnostics'
					: `Verify ${profiles.value.find((p) => p.id === profileId)?.name ?? 'connection'}`,
			status: 'running',
			percent: 0,
			message: 'Starting…',
		}
		jobs.value = [job, ...jobs.value].filter(
			(item, index) => item.status === 'running' || index < 50,
		)
		try {
			const result = await platformApi.runOperation(operation)
			const current = jobs.value.find((item) => item.id === id)!
			if (result.ok) {
				current.status = 'completed'
				current.percent = 100
				current.message = result.value.summary
			} else {
				current.status = ['CANCELLED', '-32800'].includes(result.error.code)
					? 'cancelled'
					: 'failed'
				current.message = result.error.message
			}
			current.code = undefined
		} catch {
			const current = jobs.value.find((item) => item.id === id)!
			current.status = 'failed'
			current.message = 'Desktop connection lost. The operation was not retried.'
			current.code = undefined
		}
	}
	function recordJob(job: Job) {
		const current = jobs.value.find((item) => item.id === job.id)
		if (current) Object.assign(current, job)
		else
			jobs.value = [job, ...jobs.value].filter(
				(item, index) => item.status === 'running' || index < 50,
			)
	}
	async function cancel(id: string) {
		try {
			const stop = jobs.value.find((item) => item.id === id)?.cancel
			if (stop) await stop()
			else unwrap(await platformApi.cancelOperation(id))
		} catch (cause) {
			error.value = String(cause)
		}
	}
	async function perform<T>(
		label: string,
		action: (id: string) => Promise<DesktopResult<T>>,
		report?: (value: T) => { status: Job['status']; message: string },
	): Promise<T> {
		const id = crypto.randomUUID()
		jobs.value = [
			{
				id,
				startedAt: new Date().toISOString(),
				label,
				status: 'running',
				percent: 0,
				message: 'Working…',
			},
			...jobs.value,
		].filter((item, index) => item.status === 'running' || index < 50) as Job[]
		try {
			const result = await action(id)
			const job = jobs.value.find((item) => item.id === id)!
			job.code = undefined
			if (!result.ok) {
				job.status = ['CANCELLED', '-32800'].includes(result.error.code)
					? 'cancelled'
					: 'failed'
				job.message = job.describeFailure?.(result.error.message) ?? result.error.message
				throw new Error(result.error.message)
			}
			const description = report?.(result.value)
			job.status = description?.status ?? 'completed'
			job.percent = job.percentOnCompletion ?? 100
			job.message = description?.message ?? 'Operation completed.'
			return result.value
		} catch (cause) {
			const job = jobs.value.find((item) => item.id === id)
			if (job?.status === 'running') {
				job.status = 'failed'
				job.message = job.describeFailure?.() ?? 'The desktop request could not complete.'
				job.code = undefined
			}
			throw cause
		}
	}
	function selectService(id: Service) {
		service.value = id
		selectedId.value = undefined
	}
	function selectProfile(profile: Profile) {
		service.value = profile.service
		selectedId.value = profile.id
	}
	return {
		status,
		profiles,
		theme,
		preferences,
		preferenceState,
		acceptPreferences,
		unwrapResult: unwrap,
		savePreferences,
		version,
		platform,
		service,
		selectedId,
		selected,
		activeService,
		jobs,
		error,
		ready,
		running,
		receive,
		initialize,
		save,
		remove,
		setTheme,
		restart,
		run,
		cancel,
		selectService,
		selectProfile,
		perform,
		recordJob,
	}
})
