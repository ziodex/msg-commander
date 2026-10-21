<script setup lang="ts">
import { subQueueLabel } from '@shared/service-bus'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import EntityTree from './EntityTree.vue'
import ListenerPanel from './ListenerPanel.vue'
import ReceiveDelete from './ReceiveDelete.vue'
import ServiceBusActions from './ServiceBusActions.vue'
import EntitySplitView from '../../../shared/components/EntitySplitView.vue'
import EntityTabs from './EntityTabs.vue'
import MessageTable from './MessageTable.vue'
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import NamespaceCounters from './NamespaceCounters.vue'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import type { TreeAction } from '@/features/service-bus/lib/tree-actions'
import type { MessageSummary } from '@shared/service-bus'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Badge } from '@/shared/ui/badge'
import PropertyTable from '../../../shared/components/PropertyTable.vue'
import MessageInspector from './MessageInspector.vue'
import MessageWorkbench from './MessageWorkbench.vue'
import EntityManager from './EntityManager.vue'
import EntityCopyManager from './EntityCopyManager.vue'
import RuleManager from './RuleManager.vue'
import AuthorizationManager from './AuthorizationManager.vue'
const sb = useServiceBus(),
	tree = useEntityTree(),
	monitor = useNamespaceMonitor()
const layout = useWorkspaceLayout()
const actions = ref<InstanceType<typeof ServiceBusActions>>()
const entityManager = ref<InstanceType<typeof EntityManager>>()
const copyManager = ref<InstanceType<typeof EntityCopyManager>>()
const workbench = ref<InstanceType<typeof MessageWorkbench>>()
const receiveDelete = ref<InstanceType<typeof ReceiveDelete>>()
const listenerPanel = ref<InstanceType<typeof ListenerPanel>>()
async function treeAction(action: TreeAction) {
	if (!sb.connection || sb.busy) return
	if (action.type === 'refresh') await tree.refreshEntity(action.target)
	else if (action.type === 'bulk') actions.value?.openBulk()
	else if (action.type === 'create') entityManager.value?.create(action.kind, action.topicName)
	else if (action.type === 'edit' || action.type === 'delete')
		await entityManager.value?.existing(
			action.type === 'edit' ? 'update' : 'delete',
			action.target,
		)
	else if (action.type === 'duplicate' || action.type === 'rename') {
		sb.category = action.target.kind
		sb.topicName = action.target.kind === 'subscription' ? action.target.topicName : undefined
		copyManager.value?.start(action.type, action.target)
	} else if (action.type === 'send') workbench.value?.openComposer(action.target)
	else if (action.type === 'test-job') actions.value?.openTest(action.target, action.mode)
	else if (action.type === 'listen') listenerPanel.value?.open(action.target)
	else if (action.type === 'resend') workbench.value?.openResend(action.target, action.subQueue)
	else if (action.type === 'receive-delete')
		receiveDelete.value?.open(action.target, action.subQueue)
	else if (action.type === 'purge') workbench.value?.openPurge(action.target, action.subQueue)
	else if (action.type === 'peek') await tree.select(action.entity, action.subQueue)
}
const inspectorOpen = ref(false)
const selectedMessages = ref<string[]>([])
const selection = computed(
	() =>
		sb.messages?.items.filter(
			(item) => !!item.snapshotId && selectedMessages.value.includes(item.snapshotId),
		) ?? [],
)
function desktopShortcut(event: KeyboardEvent) {
	if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Filter loaded entities"]',
		)
		if (!input) return
		event.preventDefault()
		layout.treeVisible = true
		void nextTick(() => {
			input.focus()
			input.select()
		})
	} else if (event.key === 'F5' && !event.ctrlKey && !event.metaKey && !event.altKey) {
		event.preventDefault()
		if (!sb.busy && sb.selected) void tree.refreshEntity(sb.selected.target)
	}
}
onMounted(() => window.addEventListener('keydown', desktopShortcut))
onBeforeUnmount(() => window.removeEventListener('keydown', desktopShortcut))
let messageTrigger: HTMLElement | null = null
const selectedCounts = computed(() =>
	sb.selected ? (monitor.counts(sb.selected.target) ?? sb.details?.counts) : undefined,
)
async function inspect(summary: MessageSummary) {
	messageTrigger = document.activeElement as HTMLElement
	inspectorOpen.value = true
	await sb.inspect(summary)
}
function restoreMessageFocus(event: Event) {
	event.preventDefault()
	messageTrigger?.focus()
}
watch(
	() => sb.selected,
	() => {
		inspectorOpen.value = false
	},
)
watch(
	() => sb.connection?.connectionId,
	() => {
		inspectorOpen.value = false
	},
)
const countLabels = {
	active: 'Active',
	deadLetter: 'Dead-letter',
	scheduled: 'Scheduled',
	transfer: 'Transfer',
	transferDeadLetter: 'Transfer DLQ',
	total: 'Total',
	sizeBytes: 'Size (bytes)',
} as const
function subscriptions() {
	if (sb.selected?.target.kind === 'topic') void tree.expandTopic(sb.selected.target.name)
}
</script>
<template>
	<section class="service-bus-workspace" aria-label="Service Bus workspace">
		<div class="explorer-heading">
			<div class="explorer-actions">
				<span class="connected-dot"></span><strong>Connected</strong>
			</div>
			<ServiceBusActions ref="actions" />
			<ListenerPanel ref="listenerPanel" /><ReceiveDelete ref="receiveDelete" />
			<Button variant="outline" size="sm" :disabled="!!sb.busy" @click="sb.disconnect()"
				>Disconnect</Button
			>
		</div>
		<div v-if="sb.error" class="error-banner" role="alert">{{ sb.error }}</div>
		<NamespaceCounters />
		<EntitySplitView storage-key="commander-service-bus-entities-v1">
			<template #tree><EntityTree @action="treeAction" /></template>
			<div
				class="entity-workspace"
				id="entity-tab-content"
				role="tabpanel"
				aria-label="Entity workspace"
			>
				<EntityTabs />
				<details class="entity-admin">
					<summary>Manage entities &amp; access</summary>
					<EntityManager ref="entityManager" /><EntityCopyManager
						ref="copyManager"
					/><AuthorizationManager />
				</details>

				<p v-if="!sb.selected" class="explorer-empty">
					Select a queue or subscription to browse messages.
				</p>
				<template v-else>
					<div class="explorer-heading">
						<div>
							<p
								v-if="sb.selected.target.kind === 'subscription'"
								class="entity-breadcrumb"
							>
								{{ sb.selected.target.topicName }} / Subscriptions
							</p>
							<h2>{{ sb.selected.target.name }}</h2>
						</div>
						<div
							class="explorer-tabs"
							v-if="sb.selected.target.kind !== 'topic'"
							aria-label="Entity view"
							role="group"
						>
							<button
								:aria-pressed="sb.selectionView === 'messages'"
								:disabled="!!sb.busy"
								@click="sb.peek()"
							>
								Messages
							</button>
							<button
								:aria-pressed="sb.selectionView === 'entity'"
								@click="sb.selectionView = 'entity'"
							>
								Properties
							</button>
						</div>
						<Badge v-else variant="outline">{{ sb.selected.target.kind }}</Badge>
					</div>
					<template v-if="sb.details && sb.selectionView === 'entity'">
						<div class="entity-counts">
							<div v-for="(label, key) in countLabels" :key="key">
								<span>{{ label }}</span
								><strong>{{ selectedCounts?.[key] ?? '—' }}</strong>
							</div>
						</div>
						<p class="explorer-note">
							Counts are a snapshot, may lag the broker, and do not determine the peek
							cursor. — means unavailable or not applicable.
						</p>
						<p v-if="sb.details.countsWarning" class="inspector-warning">
							{{ sb.details.countsWarning }}
						</p>
						<details>
							<summary>Entity properties</summary>
							<PropertyTable :properties="sb.details.properties" />
						</details>
					</template>
					<RuleManager
						v-if="
							sb.selected.target.kind === 'subscription' &&
							sb.selectionView === 'entity'
						"
						:key="sb.selected.target.topicName + '/' + sb.selected.target.name"
						:target="sb.selected.target"
					/>
					<div v-if="sb.selected.target.kind === 'topic'" class="explorer-empty">
						<p>Topic messages are inspected through a subscription.</p>
						<Button :disabled="!!sb.busy" @click="subscriptions"
							>Browse subscriptions</Button
						>
					</div>
					<template v-else>
						<div class="explorer-actions message-controls">
							<div class="explorer-tabs" role="group" aria-label="Message subqueue">
								<button
									:aria-pressed="sb.subQueue === 'active'"
									:disabled="!!sb.busy"
									@click="sb.changeSubQueue('active')"
								>
									Main queue</button
								><button
									:aria-pressed="sb.subQueue === 'dead-letter'"
									:disabled="!!sb.busy"
									@click="sb.changeSubQueue('dead-letter')"
								>
									Dead-letter
								</button>
								<button
									:aria-pressed="sb.subQueue === 'transfer-dead-letter'"
									:disabled="!!sb.busy"
									@click="sb.changeSubQueue('transfer-dead-letter')"
								>
									Transfer dead-letter
								</button>
							</div>
							<label
								>From sequence<Input
									v-model="sb.fromSequence"
									aria-label="From sequence"
									class="sequence-input"
									:disabled="!!sb.busy"
							/></label>
							<label
								>Page size<Input
									v-model.number="sb.pageSize"
									type="number"
									min="1"
									max="25"
									aria-label="Page size"
									class="page-size-input"
									:disabled="!!sb.busy"
							/></label>
							<Button :disabled="!!sb.busy" @click="sb.peek()">{{
								sb.busy.startsWith('Peek ')
									? 'Retrieving messages…'
									: 'Peek messages'
							}}</Button
							><Button
								variant="outline"
								:disabled="
									!!sb.busy ||
									!sb.messages ||
									sb.messages.nextSequenceNumber === null
								"
								@click="sb.peek(true)"
								>Peek next</Button
							>
							<Button
								v-if="sb.messages?.items.length"
								variant="outline"
								:disabled="
									!!sb.busy || sb.messages.items.some((item) => !item.snapshotId)
								"
								@click="sb.exportMessages(sb.messages.items)"
								>Export peek page</Button
							>
						</div>
						<LoadingIndicator
							v-if="sb.busy.startsWith('Peek ')"
							label="Retrieving messages…"
						/>
						<p v-if="sb.fileNotice" role="status" class="explorer-note">
							{{ sb.fileNotice }}
						</p>
						<p v-if="sb.messages?.warning" class="inspector-warning">
							{{ sb.messages.warning }}
						</p>
						<div
							v-if="sb.messages"
							class="message-table-wrap"
							:aria-busy="sb.busy.startsWith('Peek ')"
						>
							<div
								v-if="sb.messages.items.length"
								class="message-selection-actions"
								role="group"
								aria-label="Message selection"
							>
								<span aria-live="polite">{{ selection.length }} selected</span>
								<Button
									variant="outline"
									:disabled="!!sb.busy || !selection.length"
									title="Copy selected messages (Ctrl/Cmd+C in the table)"
									@click="sb.exportMessages(selection, 'archive', 'clipboard')"
									>Copy selected</Button
								>
								<Button
									variant="outline"
									:disabled="!!sb.busy || !selection.length"
									title="Export selected messages (Ctrl/Cmd+Shift+E in the table)"
									@click="sb.exportMessages(selection)"
									>Export selected…</Button
								>
								<Button
									variant="ghost"
									:disabled="!!sb.busy || !selection.length"
									@click="selectedMessages = []"
									>Clear selection</Button
								>
							</div>
							<MessageTable
								v-model:selection="selectedMessages"
								:messages="sb.messages.items"
								:selected-snapshot="sb.message?.summary.snapshotId"
								:disabled="!!sb.busy"
								@inspect="inspect"
								@copy="sb.exportMessages(selection, 'archive', 'clipboard')"
								@export="sb.exportMessages(selection)"
							/>
							<p v-if="!sb.messages.items.length && !sb.busy" class="explorer-empty">
								No messages returned at this sequence. Retry or peek next; an empty
								page does not guarantee the queue is empty.
							</p>
							<p class="explorer-note">
								{{ sb.messages.items.length }} messages from {{ sb.peekedFrom }} ·
								Next sequence:
								{{ sb.messages.nextSequenceNumber ?? 'End of sequence range' }}
							</p>
						</div>
						<p class="explorer-note">
							<template v-if="sb.subQueue === 'transfer-dead-letter'">
								Peeking leaves messages unchanged. These messages failed forwarding
								from this source. Inspect the failure and check the forwarding
								destination before resending.
							</template>
							<template v-else>
								Peeking does not lock or remove messages. Main queue snapshots can
								include deferred, expired and scheduled messages; they do not reveal
								lock state.
							</template>
						</p>
					</template>
				</template>
				<MessageWorkbench
					ref="workbench"
					@receive-delete="
						(target, subQueue, sessionId) =>
							receiveDelete?.open(target, subQueue, sessionId)
					"
				/>
			</div>
		</EntitySplitView>
		<Dialog :open="inspectorOpen" @update:open="inspectorOpen = $event">
			<DialogContent
				class="message-inspection-dialog"
				movable
				resizable
				@close-auto-focus="restoreMessageFocus"
			>
				<DialogHeader
					><DialogTitle>Inspect message</DialogTitle
					><DialogDescription
						>{{ sb.selected?.target.name }} · {{ subQueueLabel(sb.subQueue) }} · Message
						snapshot</DialogDescription
					></DialogHeader
				>
				<p v-if="!sb.message && sb.busy" role="status">Loading message…</p>
				<p v-if="!sb.message && sb.error" role="alert" class="error-banner">
					{{ sb.error }}
				</p>
				<MessageInspector
					:source="sb.selected?.target"
					:sub-queue="sb.subQueue"
					:can-receive="true"
					:requires-session="!!sb.selected?.requiresSession"
				/>
			</DialogContent>
		</Dialog>
		<p v-if="sb.busy" class="explorer-progress" role="status">
			{{ sb.busy }}… Use Operations to see progress or cancel.
		</p>
	</section>
</template>
