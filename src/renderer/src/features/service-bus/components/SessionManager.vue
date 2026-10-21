<script setup lang="ts">
import ActionConfirmation from '../../../shared/components/ActionConfirmation.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { composerBody } from '@/shared/lib/composer'
import { decodeBase64, hexPreview, prettyJson, utf8Preview } from '@/shared/lib/message-body'
import type { PeekTarget } from '@shared/service-bus'
import type { SessionPage, SessionState } from '@shared/sessions'
const props = defineProps<{ target: PeekTarget }>()
const emit = defineEmits<{ received: [] }>()
const sb = useServiceBus()
const page = ref<SessionPage>(),
	pageNumber = ref(1),
	selectedId = ref('')
const state = ref<SessionState>(),
	editor = ref(''),
	encoding = ref<'text' | 'json' | 'base64'>('base64')
const view = ref<'text' | 'json' | 'hex'>('text'),
	error = ref('')
const clearConfirm = ref(false),
	confirmation = ref(''),
	releaseConfirm = ref(false)
const count = ref(1),
	waitSeconds = ref(2)
const now = ref(Date.now())
let disposed = false
const timer = setInterval(() => {
	now.value = Date.now()
}, 1000)
const lease = computed(() => {
	const value = sb.held.session
	return value?.target.kind === props.target.kind &&
		value.target.name === props.target.name &&
		(value.target.kind === 'queue' ||
			(props.target.kind === 'subscription' &&
				value.target.topicName === props.target.topicName))
		? value
		: undefined
})
const active = computed(
	() => lease.value?.status === 'active' && Date.parse(lease.value.lockedUntil) > now.value,
)
const hasPending = computed(() =>
	sb.held.items.some(
		(item) =>
			item.state === 'unknown' ||
			(item.state === 'active' && Date.parse(item.lockedUntil) > now.value),
	),
)
const blockedEdit = computed(
	() =>
		!!sb.busy ||
		!active.value ||
		!state.value?.editable ||
		lease.value?.stateUncertain ||
		state.value.leaseId !== lease.value?.leaseId,
)
watch(
	() => lease.value?.leaseId,
	() => {
		state.value = undefined
		selectedId.value = lease.value?.sessionId ?? ''
		clearConfirm.value = releaseConfirm.value = false
	},
	{ immediate: true },
)
const preview = computed(() => {
	if (!state.value?.isSet) return 'No stored session state.'
	if (state.value.bodyBase64 === null) return state.value.warning ?? ''
	const bytes = decodeBase64(state.value.bodyBase64)
	const first = bytes.subarray(0, 16384)
	if (view.value === 'hex') return hexPreview(first)
	const text = utf8Preview(first, bytes.length <= first.length)
	if (text === null) return 'These bytes are not valid UTF-8. Use HEX or the base64 editor.'
	if (view.value === 'json')
		return bytes.length <= first.length
			? (prettyJson(text) ?? 'State is not valid JSON.')
			: 'JSON formatting requires the whole state to fit the 16 KiB preview.'
	return text || '(Empty state)'
})
async function browse(next = false) {
	const result = await sb.listSessions(
		props.target,
		next ? (page.value?.continuationToken ?? null) : null,
	)
	if (!result) return
	if (disposed) {
		if (result.continuationToken) sb.closeSessionScan(result.continuationToken)
		return
	}
	page.value = result
	pageNumber.value = next ? pageNumber.value + 1 : 1
}
async function accept() {
	error.value = ''
	if (await sb.acceptSession(props.target, selectedId.value)) await read()
}
async function read() {
	if (!lease.value) return
	state.value = undefined
	error.value = ''
	clearConfirm.value = false
	const result = await sb.getSessionState(lease.value.leaseId)
	if (disposed || !result || result.leaseId !== lease.value?.leaseId) return
	state.value = result
	editor.value = result.bodyBase64 ?? ''
	encoding.value = 'base64'
}
function changeEncoding(event: Event) {
	const element = event.target as HTMLSelectElement
	const next = element.value as typeof encoding.value
	try {
		const current = composerBody(editor.value, encoding.value)
		const text =
			next === 'base64' ? current.base64 : utf8Preview(decodeBase64(current.base64), true)
		if (text === null)
			throw new Error('Binary state cannot be converted to UTF-8. Keep base64.')
		composerBody(text, next)
		editor.value = text
		encoding.value = next
		error.value = ''
	} catch (cause) {
		element.value = encoding.value
		error.value = (cause as Error).message
	}
}
function showClear() {
	clearConfirm.value = true
	confirmation.value = ''
}
async function save(clear = false) {
	if (blockedEdit.value || !lease.value || !state.value?.revision) return
	try {
		error.value = ''
		const body = clear ? null : composerBody(editor.value, encoding.value).base64
		const outcome = await sb.setSessionState(
			lease.value.leaseId,
			body,
			state.value.revision,
			clear ? confirmation.value : '',
		)
		if (outcome?.status === 'confirmed') await read()
	} catch (cause) {
		error.value = (cause as Error).message
	}
}
async function release() {
	if (!lease.value) return
	await sb.releaseSession(lease.value.leaseId)
	releaseConfirm.value = false
}
async function receive() {
	const current = lease.value
	if (!current || !active.value) return
	await sb.receive(count.value, waitSeconds.value, current.sessionId, undefined, current.leaseId)
	if (!sb.error && !disposed) emit('received')
}
onBeforeUnmount(() => {
	disposed = true
	clearInterval(timer)
	if (page.value?.continuationToken) sb.closeSessionScan(page.value.continuationToken)
})
</script>
<template>
	<div class="session-manager">
		<p class="write-destination">
			{{ sb.connection?.namespace }}<br />{{ target.kind }} /
			{{ target.kind === 'subscription' ? target.topicName + ' / ' : '' }}{{ target.name }} ·
			main queue
		</p>
		<div class="explorer-actions">
			<Button variant="outline" :disabled="!!sb.busy" @click="browse()"
				>Refresh sessions</Button
			>
			<Button
				variant="outline"
				:disabled="!!sb.busy || !page?.continuationToken"
				@click="browse(true)"
				>Next sessions</Button
			>
			<span v-if="page" class="explorer-note"
				>{{ page.items.length }} sessions · page {{ pageNumber }}</span
			>
		</div>
		<p class="explorer-note">
			Listing does not accept locks. It includes sessions with active messages or stored
			state. Pages can change while other clients work; refresh to start again.
		</p>
		<div v-if="page" class="session-list" aria-label="Session list">
			<button
				v-for="id in page.items"
				:key="id"
				class="session-choice"
				:aria-pressed="id === selectedId"
				:disabled="!!sb.busy || !!sb.held.target"
				@click="selectedId = id"
			>
				{{ id }}
			</button>
			<p v-if="!page.items.length" class="explorer-note">
				No sessions returned on this page.
			</p>
		</div>
		<div class="explorer-actions">
			<label
				>Session ID<Input
					v-model="selectedId"
					aria-label="Selected session ID"
					maxlength="128"
					:disabled="!!sb.busy || !!sb.held.target"
					placeholder="Select a row or enter a known ID"
			/></label>
			<Button :disabled="!!sb.busy || !!sb.held.target || !selectedId.trim()" @click="accept"
				>Accept and inspect session</Button
			>
		</div>
		<p class="explorer-note">
			Accepting takes an exclusive session lock and temporarily prevents other consumers from
			processing it. Closing this dialog keeps the receiver open; use Release session when
			finished.
		</p>
		<p v-if="sb.held.target && !lease" class="inspector-warning">
			Another receiver is open. Settle its messages and close it in Message operations before
			accepting this session.
		</p>
		<section v-if="lease" aria-label="Owned session" class="owned-session">
			<h3>Owned session: {{ lease.sessionId }}</h3>
			<p class="explorer-note">
				{{ lease.status }} · Lock expires {{ lease.lockedUntil }} ·
				{{ Math.max(0, Math.ceil((Date.parse(lease.lockedUntil) - now) / 1000)) }}s
				remaining. The broker decides whether the lock is still valid.
			</p>
			<p v-if="!active" class="inspector-warning">
				The session lock expired or its ownership is uncertain. Release the receiver and
				explicitly accept the session again.
			</p>
			<p v-if="lease.stateUncertain" class="inspector-warning">
				State write outcome is unknown. Read state from the broker before editing again;
				nothing is retried automatically.
			</p>
			<div class="explorer-actions">
				<Button variant="outline" :disabled="!!sb.busy || !active" @click="read"
					>Read session state</Button
				>
				<Button
					variant="outline"
					:disabled="!!sb.busy || !active"
					@click="sb.renewSession(lease.leaseId)"
					>Renew session lock</Button
				>
				<Button variant="outline" :disabled="!!sb.busy" @click="releaseConfirm = true"
					>Release session</Button
				>
			</div>
			<div v-if="releaseConfirm" class="session-confirm">
				<p>
					Release {{ lease.sessionId }} without completing any outstanding messages.
					Another consumer can acquire the session; unsettled messages can be delivered
					again.
				</p>
				<Button :disabled="!!sb.busy" @click="release">Confirm release session</Button>
				<Button variant="ghost" :disabled="!!sb.busy" @click="releaseConfirm = false"
					>Keep session</Button
				>
			</div>
			<template v-if="state">
				<h4>
					Broker state · {{ state.bytes }} bytes ·
					{{ state.isSet ? 'stored' : 'not set' }}
				</h4>
				<p v-if="state.warning" class="inspector-warning">{{ state.warning }}</p>
				<div
					v-if="state.bodyBase64 !== null"
					class="explorer-tabs"
					aria-label="Session state format"
				>
					<button
						v-for="kind in ['text', 'json', 'hex'] as const"
						:key="kind"
						:aria-pressed="view === kind"
						@click="view = kind"
					>
						{{ kind.toUpperCase() }}
					</button>
				</div>
				<pre class="session-state-preview" aria-label="Session state preview">{{
					preview
				}}</pre>
				<p v-if="state.bytes > 16384 && state.editable" class="explorer-note">
					Preview shows at most 16 KiB. The editor below contains the complete state.
				</p>
				<template v-if="state.editable">
					<label
						>State encoding<select
							:value="encoding"
							aria-label="Session state encoding"
							class="commander-select"
							:disabled="blockedEdit"
							@change="changeEncoding"
						>
							<option value="base64">Base64 (exact bytes)</option>
							<option value="text">UTF-8 text</option>
							<option value="json">JSON text</option>
						</select></label
					>
					<textarea
						v-model="editor"
						aria-label="Session state editor"
						class="commander-textarea"
						rows="5"
						:disabled="blockedEdit"
						maxlength="349528"
					></textarea>
					<p class="explorer-note">
						Maximum 256 KiB locally; the namespace tier may impose additional limits.
						Text edits use UTF-8. Use Clear to remove stored state. Stored state
						survives after messages are consumed.
					</p>
					<div class="explorer-actions">
						<Button :disabled="blockedEdit" @click="save()">Save session state</Button>
						<Button variant="outline" :disabled="blockedEdit" @click="showClear"
							>Clear session state</Button
						>
					</div>
					<div v-if="clearConfirm" class="session-confirm">
						<ActionConfirmation
							v-model="confirmation"
							:expected="lease.sessionId"
							label="I understand the stored state for this session will be permanently cleared."
						/>
						<Button
							:disabled="blockedEdit || confirmation !== lease.sessionId"
							@click="save(true)"
							>Confirm clear session state</Button
						>
						<Button variant="ghost" :disabled="!!sb.busy" @click="clearConfirm = false"
							>Keep state</Button
						>
					</div>
				</template>
			</template>
			<div class="explorer-actions session-receive">
				<label
					>Maximum messages<Input
						v-model.number="count"
						type="number"
						min="1"
						max="10"
						aria-label="Session receive count"
						class="page-size-input"
				/></label>
				<label
					>Wait seconds<Input
						v-model.number="waitSeconds"
						type="number"
						min="1"
						max="20"
						aria-label="Session receive wait seconds"
						class="page-size-input"
				/></label>
				<Button :disabled="!!sb.busy || !active || hasPending" @click="receive"
					>Receive from selected session</Button
				>
			</div>
			<p class="explorer-note">
				Uses this owned session lock and Peek-Lock receive. Settle the current batch before
				receiving another. Received messages appear in Message operations.
			</p>
		</section>
		<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
		<p v-if="sb.error" role="alert" class="error-banner">{{ sb.error }}</p>
		<div v-if="sb.outcome" class="operation-outcome" role="status">
			<strong>{{ sb.outcome.status.toUpperCase() }}</strong>
			<p>{{ sb.outcome.summary }}</p>
			<Button variant="outline" :disabled="!!sb.busy" @click="sb.checkOutcome()"
				>Check outcome</Button
			>
		</div>
		<p v-if="sb.busy" role="status" class="explorer-note">
			{{ sb.busy }}… Cancel from Operations.
		</p>
	</div>
</template>
