import { serviceBusJob } from '@/features/service-bus/operation-progress'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { useListeners } from '@/features/service-bus/stores/listeners'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import {
	defaultTestGenerator,
	testJobRequestSchema,
	type TestJobResult,
	type TestGenerator,
} from '@shared/contracts/service-bus/test-jobs'
import type { EntityTarget } from '@shared/service-bus'
import { entityPath } from '@shared/entity-management'
import { testJobsApi } from '../api'

export function useTestJob() {
	const sb = useServiceBus(),
		workspace = useWorkspace(),
		listeners = useListeners(),
		monitor = useNamespaceMonitor()
	type Setup = { target: EntityTarget; mode: 'send' | 'receive' }
	const visible = ref(false),
		source = ref<Setup>(),
		pending = ref<Setup>()
	const maxMessages = ref(10),
		maxSeconds = ref(30),
		delayMs = ref(0),
		workers = ref(1),
		batchSize = ref(1),
		sessionId = ref('')
	const body = ref('{"test":true}'),
		contentType = ref('application/json'),
		acknowledged = ref(false)
	const generator = ref<TestGenerator>({ ...defaultTestGenerator })
	const settlement = ref<'complete' | 'abandon' | 'defer' | 'dead-letter'>('complete')
	const deadLetterReason = ref('TestJob'),
		deadLetterDescription = ref('')
	const settlementLabel = computed(
		() =>
			({
				complete: 'Complete',
				abandon: 'Abandon',
				defer: 'Defer',
				'dead-letter': 'Dead-letter',
			})[settlement.value],
	)
	const receiveWarning = computed(
		() =>
			({
				complete:
					'This job permanently completes any available messages, including existing messages from other applications. It keeps waiting through idle periods until the count or time limit. Message bodies are not saved.',
				abandon:
					'Releases messages for redelivery. Stops if a sequence returns; delivery count may increase. Lock expiry can still cause dead-lettering.',
				defer: 'Removes messages from normal receiving. Exact sequences are retained for retrieval during this app session. Maximum 1,000 messages.',
				'dead-letter':
					'Moves available messages to their dead-letter queue with the reason below, including messages from other applications.',
			})[settlement.value],
	)
	const acknowledgement = computed(() =>
		source.value?.mode === 'send'
			? 'I understand this sends real messages to this entity.'
			: {
					complete:
						'I understand this permanently completes messages, including existing messages.',
					abandon: 'I understand this releases messages and increases delivery counts.',
					defer: 'I understand this defers messages and requires sequence numbers to retrieve them.',
					'dead-letter': 'I understand this moves messages to the dead-letter queue.',
				}[settlement.value],
	)
	const operationId = ref(''),
		result = ref<TestJobResult>(),
		error = ref(''),
		interrupted = ref(false),
		reviewed = ref(false),
		stopping = ref(false)
	let generation = 0
	const job = computed(() =>
		serviceBusJob(workspace.jobs.find((j) => j.id === operationId.value)),
	)
	const running = computed(() => job.value?.status === 'running')
	const progress = computed(() => job.value?.testJob)
	const confirmed = computed(() =>
		result.value
			? result.value.sent + result.value.settled
			: (progress.value?.sent ?? 0) + (progress.value?.settled ?? 0),
	)
	const elapsedMs = ref(0)
	let progressTimer: ReturnType<typeof setInterval> | undefined
	watch(running, (active) => {
		clearInterval(progressTimer)
		if (!active) return
		const started = Date.now()
		elapsedMs.value = 0
		progressTimer = setInterval(() => {
			elapsedMs.value = Date.now() - started
		}, 250)
	})
	onBeforeUnmount(() => clearInterval(progressTimer))
	const duration = computed(
		() => result.value?.elapsedMs ?? Math.max(elapsedMs.value, progress.value?.elapsedMs ?? 0),
	)
	const rate = computed(() =>
		duration.value > 0 ? ((confirmed.value * 1000) / duration.value).toFixed(1) : '0.0',
	)
	const unresolved = computed(
		() =>
			interrupted.value ||
			(!!(
				result.value?.uncertain ||
				result.value?.cleanupWarning ||
				result.value?.referenceWarning
			) &&
				!reviewed.value),
	)
	const blocked = computed(() => !!sb.held.target || listeners.active)
	const input = computed(() => ({
		...source.value,
		maxMessages: maxMessages.value,
		maxSeconds: maxSeconds.value,
		delayMs: delayMs.value,
		workers: workers.value,
		batchSize: batchSize.value,
		sessionId: sessionId.value,
		body: source.value?.mode === 'send' && generator.value.kind !== 'binary' ? body.value : '',
		contentType:
			source.value?.mode === 'send' && generator.value.kind === 'literal'
				? contentType.value
				: '',
		generator:
			source.value?.mode === 'send' ? { ...generator.value } : { ...defaultTestGenerator },
		settlement: source.value?.mode === 'receive' ? settlement.value : 'complete',
		deadLetterReason:
			source.value?.mode === 'receive' && settlement.value === 'dead-letter'
				? deadLetterReason.value
				: '',
		deadLetterDescription:
			source.value?.mode === 'receive' && settlement.value === 'dead-letter'
				? deadLetterDescription.value
				: '',
		acknowledged: acknowledged.value,
	}))
	const valid = computed(
		() =>
			testJobRequestSchema.safeParse({
				id: crypto.randomUUID(),
				connectionId: sb.connection?.connectionId,
				...input.value,
			}).success,
	)
	function reset() {
		operationId.value = ''
		result.value = undefined
		error.value = ''
		interrupted.value = reviewed.value = stopping.value = acknowledged.value = false
		elapsedMs.value = 0
	}
	function open(
		target: EntityTarget,
		mode: 'send' | 'receive' = target.kind === 'subscription' ? 'receive' : 'send',
	) {
		if (sb.busy || !sb.connection) return
		pending.value = { target: { ...target }, mode }
		if (!operationId.value) {
			source.value = { ...pending.value }
			pending.value = undefined
			sessionId.value = ''
			acknowledged.value = false
		}
		visible.value = true
	}
	function prepare() {
		if (sb.busy || unresolved.value) return
		const next = pending.value ?? source.value
		reset()
		source.value = next ? { target: { ...next.target }, mode: next.mode } : undefined
		pending.value = undefined
		sessionId.value = ''
	}
	watch(
		[
			source,
			maxMessages,
			maxSeconds,
			delayMs,
			workers,
			batchSize,
			sessionId,
			body,
			contentType,
			generator,
			settlement,
			deadLetterReason,
			deadLetterDescription,
		],
		() => {
			acknowledged.value = false
		},
		{ deep: true, flush: 'sync' },
	)
	watch(
		() => sb.connection?.connectionId,
		() => {
			generation++
			visible.value = false
			source.value = pending.value = undefined
			reset()
		},
		{ flush: 'sync' },
	)
	function remember(value: TestJobResult) {
		result.value = value
		interrupted.value = false
		monitor.stale = true
	}
	async function start() {
		if (
			!valid.value ||
			!source.value ||
			operationId.value ||
			sb.busy ||
			blocked.value ||
			!sb.connection
		)
			return
		const ticket = generation,
			connectionId = sb.connection.connectionId
		const setup = {
			...input.value,
			target: { ...source.value.target },
			mode: source.value.mode,
			acknowledged: true as const,
		}
		sb.busy = 'Running test job'
		error.value = ''
		try {
			const value = await workspace.perform(
				`${setup.mode === 'send' ? 'Send' : 'Receive'} test: ${entityPath(setup.target)}`,
				async (id) => {
					operationId.value = id
					try {
						const response = await testJobsApi.run({ id, connectionId, ...setup })
						if (
							ticket === generation &&
							!response.ok &&
							['OUTCOME_UNKNOWN', 'TIMEOUT', 'BACKEND_UNAVAILABLE'].includes(
								response.error.code,
							)
						)
							interrupted.value = true
						return response
					} catch (cause) {
						if (ticket === generation) interrupted.value = true
						throw cause
					}
				},
				(value) => ({
					status:
						value.status === 'cancelled'
							? 'cancelled'
							: ['unknown', 'failed'].includes(value.status)
								? 'failed'
								: 'completed',
					message: `${value.summary} Receipt: ${value.operationId}`,
				}),
			)
			if (ticket === generation) remember(value)
		} catch (cause) {
			if (ticket === generation)
				error.value = cause instanceof Error ? cause.message : 'Test job failed.'
		} finally {
			if (ticket === generation) {
				sb.busy = ''
				void monitor.refresh()
			}
		}
	}
	async function check() {
		if (!sb.connection || sb.busy || !operationId.value) return
		const ticket = generation,
			connectionId = sb.connection.connectionId,
			current = operationId.value
		sb.busy = 'Check test job result'
		try {
			const value = await workspace.perform('Check test job result', (id) =>
				testJobsApi.result({ id, connectionId, operationId: current }),
			)
			if (ticket !== generation) return
			if (value) {
				error.value = ''
				remember(value)
			} else
				error.value =
					'No receipt is available. This does not prove that nothing was sent or completed. Review the target before reconnecting.'
		} catch (cause) {
			if (ticket === generation)
				error.value = cause instanceof Error ? cause.message : 'Result unavailable.'
		} finally {
			if (ticket === generation) sb.busy = ''
		}
	}
	async function cancel() {
		stopping.value = true
		await workspace.cancel(operationId.value)
		stopping.value = false
	}
	function show() {
		if (operationId.value) visible.value = true
		else if (sb.selected) open(sb.selected.target)
	}
	return {
		sb,
		visible,
		source,
		maxMessages,
		maxSeconds,
		delayMs,
		workers,
		batchSize,
		sessionId,
		body,
		contentType,
		acknowledged,
		generator,
		settlement,
		deadLetterReason,
		deadLetterDescription,
		settlementLabel,
		receiveWarning,
		acknowledgement,
		operationId,
		result,
		error,
		interrupted,
		reviewed,
		stopping,
		running,
		progress,
		confirmed,
		duration,
		rate,
		unresolved,
		blocked,
		valid,
		open,
		show,
		prepare,
		start,
		check,
		cancel,
		hasResult: computed(() => !!operationId.value),
	}
}
