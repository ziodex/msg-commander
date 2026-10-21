<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { useEntityCopy } from '@/features/service-bus/stores/entity-copy'
import {
	entityCopyConfirmation,
	entityCopySpecSchema,
	type EntityCopySpec,
} from '@shared/entity-copy'
import { entityPath } from '@shared/entity-management'
import type { EntityTarget } from '@shared/service-bus'
const sb = useServiceBus(),
	workspace = useWorkspace(),
	copy = useEntityCopy()
const open = ref(false),
	source = ref<EntityTarget>(),
	mode = ref<'duplicate' | 'rename'>('duplicate'),
	name = ref(''),
	topic = ref(''),
	children = ref(true)
const confirmation = ref(''),
	acknowledged = ref(false),
	validation = ref(''),
	showForm = ref(false)
const spec = computed<EntityCopySpec | undefined>(() =>
	source.value
		? {
				source: source.value,
				destination:
					source.value.kind === 'subscription'
						? { kind: 'subscription', name: name.value, topicName: topic.value }
						: { kind: source.value.kind, name: name.value },
				mode: mode.value,
				includeSubscriptions: source.value.kind === 'topic' && children.value,
			}
		: undefined,
)
const phrase = computed(() =>
	copy.review && copy.result
		? entityCopyConfirmation(sb.connection?.namespace ?? '', copy.result.spec, true)
		: copy.preview
			? entityCopyConfirmation(sb.connection?.namespace ?? '', copy.preview.spec)
			: '',
)
const requiresTyping = computed(() => !!copy.review && copy.result?.spec.source.kind !== 'queue')
const confirmed = computed(() => !requiresTyping.value || confirmation.value === phrase.value)
const activeJob = computed(() =>
	workspace.jobs.find((job) => job.status === 'running' && job.label === sb.busy),
)
function clearConfirm() {
	confirmation.value = ''
	acknowledged.value = false
	validation.value = ''
}
function start(value: 'duplicate' | 'rename', target = sb.selected?.target) {
	if (!target || sb.busy || !sb.connection || !copy.startNew()) return
	source.value = { ...target }
	mode.value = value
	name.value = value === 'duplicate' ? source.value.name + '-copy' : ''
	topic.value = source.value.kind === 'subscription' ? source.value.topicName : ''
	children.value = source.value.kind === 'topic'
	showForm.value = true
	clearConfirm()
	open.value = true
}
function history() {
	const latest = copy.result ?? copy.history[0]
	if (latest) copy.select(latest.operationId)
	showForm.value = false
	clearConfirm()
	open.value = true
}
function selectResult(id: string) {
	copy.select(id)
	showForm.value = false
	clearConfirm()
}
defineExpose({ start })
function close(value: boolean) {
	if (sb.busy) return
	open.value = value
	if (!value) {
		clearConfirm()
		if (copy.result) void sb.browse(sb.category, sb.topicName)
	}
}
async function prepare() {
	clearConfirm()
	const parsed = entityCopySpecSchema.safeParse(spec.value)
	if (!parsed.success) {
		validation.value = parsed.error.issues.map((i) => i.message).join(' ')
		return
	}
	await copy.prepare(parsed.data)
}
async function execute() {
	if (!confirmed.value || !acknowledged.value) return
	await copy.execute(phrase.value)
	if (copy.result) showForm.value = false
	clearConfirm()
}
async function review() {
	clearConfirm()
	await copy.reviewSource()
}
async function finish() {
	if (!confirmed.value || !acknowledged.value) return
	await copy.finish(phrase.value)
	clearConfirm()
}
watch([name, topic, children], () => {
	copy.clearPreview()
	clearConfirm()
})
watch(
	() => sb.connection?.connectionId,
	() => {
		open.value = false
		source.value = undefined
		clearConfirm()
	},
)
</script>
<template>
	<div class="explorer-actions">
		<Button
			size="sm"
			variant="outline"
			:disabled="!sb.selected || !!sb.busy || copy.unresolved"
			@click="start('duplicate')"
			>Duplicate selected entity</Button
		>
		<Button
			size="sm"
			variant="outline"
			:disabled="!sb.selected || !!sb.busy || copy.unresolved"
			@click="start('rename')"
			>Rename selected entity</Button
		>
		<Button
			v-if="copy.history.length"
			size="sm"
			variant="outline"
			:disabled="!!sb.busy"
			@click="history"
			>Copy / rename jobs</Button
		>
	</div>
	<Dialog :open="open" @update:open="close">
		<DialogContent
			class="message-dialog entity-dialog rule-dialog"
			@escape-key-down="sb.busy && $event.preventDefault()"
			@interact-outside="sb.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Duplicate or rename entity</DialogTitle
				><DialogDescription
					>Copy configuration in this namespace. A staged rename keeps the source until
					you separately confirm its removal.</DialogDescription
				></DialogHeader
			>
			<div class="write-destination">
				<strong>{{ sb.connection?.namespace }}</strong
				><span v-if="source && showForm">{{ source.kind }} / {{ entityPath(source) }}</span>
			</div>
			<p class="inspector-warning">
				Messages, dead letters, scheduled messages, session state and SAS policies are not
				copied. Forwarding destinations and client references keep their existing paths. A
				subscription copy can receive new matching messages from its topic. Check
				permissions and client cutover separately.
			</p>
			<p v-if="copy.error" class="form-error" role="alert">{{ copy.error }}</p>
			<p v-if="validation" class="form-error" role="alert">{{ validation }}</p>
			<form v-if="showForm && source" class="connection-form" @submit.prevent="prepare">
				<h3>
					{{ mode === 'rename' ? 'Prepare staged rename' : 'Duplicate configuration' }}
				</h3>
				<label
					>Destination name<Input
						v-model="name"
						aria-label="Copy destination name"
						:disabled="!!sb.busy"
						:maxlength="source.kind === 'subscription' ? 50 : 260"
				/></label>
				<label v-if="source.kind === 'subscription'"
					>Destination topic<Input
						v-model="topic"
						aria-label="Copy destination topic"
						:disabled="!!sb.busy || mode === 'rename'"
				/></label>
				<label v-if="source.kind === 'topic'" class="checkbox-label"
					><input
						v-model="children"
						type="checkbox"
						:disabled="!!sb.busy || mode === 'rename'"
					/>Include subscriptions and their rules</label
				>
				<Button type="submit" variant="outline" :disabled="!!sb.busy || copy.unresolved"
					>Preview configuration copy</Button
				>
			</form>
			<section
				v-if="showForm && copy.preview"
				aria-label="Entity copy preview"
				class="connection-form"
			>
				<p>
					{{ copy.preview.entities.length }} entities ·
					{{ copy.preview.entities.reduce((sum, item) => sum + item.rules.length, 0) }}
					subscription rules · {{ copy.preview.stepCount }} steps. Preview expires
					{{ new Date(copy.preview.expiresOn).toLocaleTimeString() }}.
				</p>
				<p class="explorer-note">
					Destinations start disabled. Each subscription starts with a false guard rule;
					its original rules, including an existing $Default rule, are then copied.
					Original statuses are restored after configuration, and the result is read back
					for verification. No existing destination is overwritten.
				</p>
				<details
					v-for="item in copy.preview.entities"
					:key="item.source.kind + entityPath(item.source)"
				>
					<summary>
						{{ item.source.kind }} {{ entityPath(item.source) }} →
						{{ entityPath(item.destination) }} · {{ item.rules.length }} rules
					</summary>
					<table
						class="message-table"
						:aria-label="`Copied settings for ${entityPath(item.destination)}`"
					>
						<tbody>
							<tr v-for="(value, key) in item.settings" :key="key">
								<th>{{ String(key).replace(/([A-Z])/g, ' $1') }}</th>
								<td>{{ value === null ? 'Not applicable' : String(value) }}</td>
							</tr>
						</tbody>
					</table>
					<ul v-if="item.rules.length">
						<li v-for="rule in item.rules" :key="rule.name">
							{{ rule.name }} · {{ rule.filterType
							}}{{ rule.hasAction ? ' · action' : '' }}
						</li>
					</ul>
				</details>
			</section>
			<template v-if="!showForm">
				<div v-if="copy.history.length > 1" class="copy-history">
					<span>Jobs in this connection</span
					><Button
						v-for="item in copy.history"
						:key="item.operationId"
						variant="outline"
						size="sm"
						:disabled="!!sb.busy"
						@click="selectResult(item.operationId)"
						>{{ item.spec.mode }} {{ entityPath(item.spec.destination) }} ·
						{{ item.status }}</Button
					>
				</div>
				<section v-if="copy.result" aria-label="Entity copy result" class="connection-form">
					<h3>
						{{ entityPath(copy.result.spec.source) }} →
						{{ entityPath(copy.result.spec.destination) }}
					</h3>
					<p role="status">
						<strong>{{ copy.result.status }}</strong> · {{ copy.result.summary }}
					</p>
					<p class="explorer-note">Receipt: {{ copy.result.operationId }}</p>
					<div class="message-table-wrap">
						<table class="message-table" aria-label="Entity copy steps">
							<thead>
								<tr>
									<th>Step</th>
									<th>Destination</th>
									<th>Result</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="step in copy.result.steps" :key="step.index">
									<td>{{ step.action }}</td>
									<td>
										{{ entityPath(step.target)
										}}{{ step.ruleName ? ' / ' + step.ruleName : '' }}
									</td>
									<td>{{ step.status }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p
						v-if="['partial', 'unknown'].includes(copy.result.status)"
						class="inspector-warning"
					>
						Some destination changes may exist. No retry, rollback or source deletion
						was performed. Inspect both entities and this receipt before reconnecting to
						start another copy.
					</p>
					<Button variant="outline" :disabled="!!sb.busy" @click="copy.check"
						>Check copy result</Button
					>
					<template
						v-if="
							copy.result.spec.mode === 'rename' && copy.result.status === 'confirmed'
						"
					>
						<p class="explorer-note">
							Switch clients to the destination and stop source traffic. Drain all
							source messages, then disable the old source using Edit selected entity.
							Return to Copy / rename jobs to review removal. These job handles last
							only for this namespace connection; disconnecting never deletes the
							source.
						</p>
						<Button
							variant="outline"
							:disabled="!!sb.busy || !copy.result.canFinishRename || copy.unresolved"
							@click="review"
							>Review source removal</Button
						>
					</template>
				</section>
				<section
					v-if="copy.review"
					aria-label="Rename source review"
					class="connection-form"
				>
					<h3>Remove old source after cutover</h3>
					<p class="inspector-warning">
						Source deletion is permanent and is not an atomic rename. Counts and
						configuration checks are best effort; stop all source traffic, including
						traffic to a subscription's parent topic. Messages arriving after the last
						count check can be lost. Topic deletion also removes its old subscriptions
						and their rules.
					</p>
					<table class="message-table" aria-label="Source message counts">
						<thead>
							<tr>
								<th>Source</th>
								<th>Status</th>
								<th>Total</th>
								<th>DLQ</th>
								<th>Scheduled</th>
								<th>Transfer / DLQ</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="item in copy.review.entities" :key="entityPath(item.target)">
								<td>{{ entityPath(item.target) }}</td>
								<td>{{ item.status }}</td>
								<td>{{ item.counts.total ?? '—' }}</td>
								<td>{{ item.counts.deadLetter ?? '—' }}</td>
								<td>{{ item.counts.scheduled ?? '—' }}</td>
								<td>
									{{ item.counts.transfer ?? '—' }} /
									{{ item.counts.transferDeadLetter ?? '—' }}
								</td>
							</tr>
						</tbody>
					</table>
					<ul v-if="copy.review.blockers.length" role="alert" class="form-error">
						<li v-for="blocker in copy.review.blockers" :key="blocker">
							{{ blocker }}
						</li>
					</ul>
				</section>
				<section
					v-if="copy.removal"
					aria-label="Source removal result"
					class="inspector-warning"
				>
					<strong>{{ copy.removal.status }}</strong> · {{ copy.removal.summary }}
					<p>Receipt: {{ copy.removal.operationId }}</p>
					<Button variant="outline" :disabled="!!sb.busy" @click="copy.checkRemoval"
						>Check source removal result</Button
					>
				</section>
			</template>
			<div v-if="phrase" class="connection-form">
				<label v-if="requiresTyping"
					>Type this exact confirmation<code class="copy-phrase">{{ phrase }}</code
					><Input
						v-model="confirmation"
						aria-label="Confirm entity copy or removal"
						:disabled="!!sb.busy || copy.unresolved"
						autocomplete="off"
				/></label>
				<label class="checkbox-label"
					><input
						v-model="acknowledged"
						type="checkbox"
						:disabled="!!sb.busy || copy.unresolved"
					/>{{
						copy.review
							? 'I switched clients, stopped source traffic, and accept permanent source deletion.'
							: 'I reviewed the copied settings and understand that messages and credentials are not copied.'
					}}</label
				>
				<Button
					:variant="copy.review ? 'destructive' : 'default'"
					:disabled="
						!!sb.busy ||
						copy.unresolved ||
						!confirmed ||
						!acknowledged ||
						!!copy.review?.blockers.length
					"
					@click="copy.review ? finish() : execute()"
					>{{
						copy.review
							? 'Delete old source'
							: mode === 'rename'
								? 'Create renamed destination'
								: 'Duplicate entity'
					}}</Button
				>
			</div>
			<div v-if="activeJob" class="connection-form" role="status">
				<span
					>{{ activeJob.label }} · {{ Math.round(activeJob.percent ?? 0) }}% —
					{{ activeJob.message }}</span
				><progress
					aria-label="Entity copy progress"
					:value="activeJob.percent ?? 0"
					max="100"
				></progress
				><Button variant="outline" @click="workspace.cancel(activeJob.id)"
					>Cancel copy / rename operation</Button
				>
			</div>
		</DialogContent>
	</Dialog>
</template>
<style scoped>
.copy-phrase {
	display: block;
	overflow-wrap: anywhere;
	white-space: normal;
	font-size: 12px;
}
.copy-history {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}
details {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 10px;
}
summary {
	cursor: pointer;
}
td,
th {
	overflow-wrap: anywhere;
}
ul {
	padding-left: 20px;
	list-style: disc;
}
progress {
	width: 100%;
}
</style>
