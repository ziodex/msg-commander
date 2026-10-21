<script setup lang="ts">
import { eventGridApi } from '@/features/event-grid/api'

import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { ChevronDown, ChevronRight, Layers, Workflow } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import EventGridMenu from './EventGridMenu.vue'
import { ContextMenuItem } from 'reka-ui'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import { useEventGrid } from '@/features/event-grid/stores/event-grid'
import { useWorkspace } from '@/shared/workspace/store'
import {
	eventGridConnectSchema,
	eventGridNamespace,
	eventGridPath,
} from '@shared/contracts/event-grid/core'
import type { Profile } from '@shared/contracts'
import JsonBody from '../../../shared/components/JsonBody.vue'
import EventGridEditor from './EventGridEditor.vue'
import EventGridPublisher from './EventGridPublisher.vue'
import EventGridReceiver from './EventGridReceiver.vue'
import { eventGridTopic, type EventGridTarget } from '@shared/contracts/event-grid/core'
const props = defineProps<{ profile: Profile }>(),
	emit = defineEmits<{ settings: []; remove: [] }>(),
	grid = useEventGrid(),
	workspace = useWorkspace()
const receivingTarget = ref<EventGridTarget>()
function receiveTarget(target: EventGridTarget) {
	if (grid.blocked) return
	grid.closeInspection()
	receivingTarget.value = { ...target }
}
const publishingTopic = ref('')
function publishTopic(topic: string) {
	if (grid.writeBlocked) return
	grid.closeInspection()
	publishingTopic.value = topic
}
const editor = ref<{ target: EventGridTarget; action: 'create' | 'update' | 'delete' }>()
function edit(target: EventGridTarget, action: 'create' | 'update' | 'delete') {
	if (grid.writeBlocked) return
	grid.closeInspection()
	editor.value = { target: { ...target }, action }
}
const resourceId = ref(''),
	tenantId = ref(props.profile.tenantId),
	clientId = ref(props.profile.clientId),
	formError = ref(''),
	query = ref('')
watch(
	() => props.profile,
	() => {
		resourceId.value = ''
		tenantId.value = props.profile.tenantId
		clientId.value = props.profile.clientId
		formError.value = ''
		query.value = ''
		publishingTopic.value = ''
		receivingTarget.value = undefined
		editor.value = undefined
		grid.closeInspection()
	},
)
onBeforeUnmount(() => grid.closeInspection())
const connected = computed(() => grid.connection?.profileId === props.profile.id)
const topics = computed(
	() =>
		grid.topics?.items.filter((i) =>
			i.name.toLowerCase().includes(query.value.toLowerCase()),
		) ?? [],
)
const job = computed(() => workspace.jobs.find((j) => j.id === grid.operationId))
async function connect() {
	const setup = {
		id: crypto.randomUUID(),
		profileId: props.profile.id,
		management: {
			resourceId: resourceId.value.trim(),
			tenantId: tenantId.value.trim(),
			clientId: clientId.value.trim(),
		},
	}
	const parsed = eventGridConnectSchema.safeParse(setup)
	if (!parsed.success) {
		formError.value =
			'Enter the full Event Grid namespace ARM resource ID, tenant and public client application ID.'
		return
	}
	formError.value = ''
	const { id: _id, ...value } = parsed.data
	await grid.connect(value)
}
async function signIn() {
	const value = await eventGridApi.openDeviceLogin()
	if (!value.ok) grid.error = value.error.message
}
</script>
<template>
	<section class="event-grid-explorer" aria-label="Event Grid resources">
		<div class="nh-heading">
			<div>
				<div class="eyebrow">Event Grid</div>
				<h2>{{ connected ? 'Namespace resources' : 'Connect Event Grid' }}</h2>
				<p class="field-hint">
					{{ profile.namespace }} · Namespace topics and event subscriptions
				</p>
			</div>
			<div class="nh-actions">
				<Button variant="ghost" size="sm" :disabled="grid.blocked" @click="emit('settings')"
					>Connection settings</Button
				><Button variant="ghost" size="sm" :disabled="grid.blocked" @click="emit('remove')"
					>Remove connection</Button
				>
			</div>
		</div>
		<form v-if="!connected" class="eg-setup" @submit.prevent="connect">
			<p>
				Connect with Microsoft Entra to browse and manage namespace topics and event
				subscriptions.
			</p>
			<label
				>Event Grid namespace resource ID<Input
					v-model="resourceId"
					:disabled="grid.blocked"
					placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.EventGrid/namespaces/…"
			/></label>
			<div class="nh-fields">
				<label
					>Event Grid management tenant<Input
						v-model="tenantId"
						:disabled="grid.blocked" /></label
				><label
					>Event Grid management application ID<Input
						v-model="clientId"
						:disabled="grid.blocked"
				/></label>
			</div>
			<p class="field-hint">
				Use the HTTP topics hostname from the namespace overview in the connection settings.
				A role such as Reader on the namespace provides ARM discovery access. Discovery
				reads only the chosen namespace. Changes require ARM write/delete permissions.
			</p>
			<Button type="submit" :disabled="grid.blocked || !workspace.ready"
				>Connect Event Grid</Button
			>
		</form>
		<template v-else>
			<div class="nh-toolbar">
				<span class="nh-connected"
					><span class="status-dot ready" />Event Grid connected</span
				><span class="field-hint"
					>{{ grid.connection?.location }} · Resource administration</span
				><Button
					variant="ghost"
					size="sm"
					:disabled="grid.blocked"
					@click="grid.disconnect()"
					>Disconnect Event Grid</Button
				>
			</div>
			<section v-if="grid.outcome" class="nh-working" aria-label="Event Grid change receipt">
				<p :class="grid.outcome.status === 'confirmed' ? 'field-hint' : 'form-warning'">
					{{ grid.outcome.summary }}
				</p>
				<p class="field-hint">
					{{ grid.outcome.status }} · Receipt: {{ grid.outcome.operationId }}
				</p>
				<div class="nh-actions">
					<Button variant="outline" :disabled="grid.blocked" @click="grid.recover()"
						>Recover Event Grid receipt</Button
					><Button
						variant="outline"
						:disabled="grid.blocked"
						@click="grid.inspect(grid.outcome.target)"
						>Inspect changed resource</Button
					>
				</div>
				<label v-if="['unknown', 'accepted'].includes(grid.outcome.status)" class="eg-check"
					><input v-model="grid.reviewed" type="checkbox" :disabled="grid.blocked" /> I
					reviewed the receipt and Azure state before another change.</label
				>
			</section>
			<section
				v-if="grid.publishOutcome"
				aria-label="Last CloudEvents publish"
				class="eg-admin-receipt"
			>
				<strong>CloudEvents · {{ grid.publishOutcome.status }}</strong>
				<p>{{ grid.publishOutcome.summary }}</p>
				<div class="nh-actions">
					<Button
						variant="outline"
						:disabled="grid.blocked"
						@click="grid.recoverPublish()"
						>Recover publish receipt</Button
					><Button
						variant="outline"
						:disabled="grid.blocked"
						@click="publishingTopic = grid.publishOutcome!.topicName"
						>Open publisher receipt</Button
					>
				</div>
				<label v-if="grid.publishOutcome.status === 'unknown'" class="eg-check"
					><input
						v-model="grid.publishReviewed"
						type="checkbox"
						:disabled="grid.blocked"
					/>
					I reviewed the uncertain send and possible duplicates before sending
					again.</label
				>
			</section>
			<section
				v-if="grid.pullOutcome"
				class="eg-admin-receipt"
				aria-label="Last Event Grid pull operation"
			>
				<strong>Pull events · {{ grid.pullOutcome.status }}</strong>
				<p>{{ grid.pullOutcome.summary }}</p>
				<div class="nh-actions">
					<Button variant="outline" :disabled="grid.blocked" @click="grid.recoverPull()"
						>Recover pull receipt</Button
					><Button
						variant="outline"
						:disabled="grid.blocked"
						@click="receiveTarget(grid.pullOutcome.target)"
						>Open received events</Button
					>
				</div>
				<label v-if="grid.pullOutcome.status === 'unknown'" class="eg-check"
					><input v-model="grid.pullReviewed" type="checkbox" :disabled="grid.blocked" />
					I reviewed the uncertain outcome and retained events before another
					operation.</label
				>
			</section>
			<div class="nh-actions">
				<Button :disabled="grid.writeBlocked" @click="edit(eventGridTopic(''), 'create')"
					>Create Event Grid topic</Button
				>
				<Button variant="outline" :disabled="grid.blocked" @click="grid.loadTopics()"
					>Refresh Event Grid resources</Button
				><Button
					variant="outline"
					:disabled="grid.blocked"
					@click="grid.inspect(eventGridNamespace)"
					>Inspect namespace</Button
				><Button
					size="sm"
					variant="ghost"
					@click="grid.expanded = topics.map((i) => i.name)"
					>Expand all topics</Button
				><Button size="sm" variant="ghost" @click="grid.expanded = []"
					>Collapse all topics</Button
				>
			</div>
			<label class="eg-search"
				>Find a loaded topic<Input v-model="query" placeholder="Filter loaded topics…"
			/></label>
			<p class="field-hint">
				{{ grid.topics?.items.length ?? 0 }} topics loaded{{
					grid.topics?.continuationToken ? ' · more available' : ''
				}}. Expand a topic to load its subscriptions. Counts describe loaded resources, not
				queued events.
			</p>
			<div class="eg-tree" role="tree" aria-label="Event Grid namespace tree">
				<EventGridMenu :disabled="grid.blocked"
					><template #trigger
						><button
							class="eg-node eg-namespace"
							role="treeitem"
							aria-expanded="true"
							:disabled="grid.blocked"
							@click="grid.inspect(eventGridNamespace)"
						>
							<Workflow :size="18" />{{ grid.connection?.resourceId.split('/').at(-1)
							}}<small>Namespace</small>
						</button></template
					><template #default
						><ContextMenuItem
							class="entity-context-item"
							:disabled="grid.blocked"
							@select="grid.inspect(eventGridNamespace)"
							>Inspect namespace</ContextMenuItem
						><ContextMenuItem
							class="entity-context-item"
							:disabled="grid.writeBlocked"
							@select="edit(eventGridTopic(''), 'create')"
							>Create topic</ContextMenuItem
						><ContextMenuItem
							class="entity-context-item"
							:disabled="grid.blocked"
							@select="grid.loadTopics()"
							>Refresh topics</ContextMenuItem
						></template
					></EventGridMenu
				>
				<div role="group" class="eg-topics">
					<div
						v-for="item in topics"
						:key="item.name"
						role="treeitem"
						:aria-expanded="grid.expanded.includes(item.name)"
						:aria-label="`Event Grid topic ${item.name}`"
					>
						<EventGridMenu :disabled="grid.blocked"
							><template #trigger
								><div class="eg-topic-row">
									<Button
										variant="ghost"
										size="sm"
										:aria-label="`${grid.expanded.includes(item.name) ? 'Collapse' : 'Expand'} Event Grid topic ${item.name}`"
										:disabled="grid.blocked"
										@click="grid.toggle(item.name)"
										><component
											:is="
												grid.expanded.includes(item.name)
													? ChevronDown
													: ChevronRight
											"
											:size="16" /></Button
									><button
										class="eg-node"
										:disabled="grid.blocked"
										@click="grid.inspect(item.target)"
									>
										<Layers :size="16" />{{ item.name
										}}<small
											>{{ item.provisioningState ?? 'State not supplied' }} ·
											{{ item.inputSchema ?? 'Schema not supplied' }}</small
										></button
									><Button
										variant="ghost"
										size="sm"
										:disabled="grid.blocked"
										@click="grid.loadSubscriptions(item.name)"
										>Refresh subscriptions</Button
									>
								</div></template
							><template #default
								><ContextMenuItem
									class="entity-context-item"
									:disabled="grid.blocked"
									@select="grid.inspect(item.target)"
									>Inspect topic</ContextMenuItem
								><ContextMenuItem
									class="entity-context-item"
									:disabled="grid.writeBlocked"
									@select="publishTopic(item.name)"
									>Publish CloudEvents…</ContextMenuItem
								><ContextMenuItem
									class="entity-context-item"
									:disabled="grid.writeBlocked"
									@select="
										edit(
											{
												kind: 'subscription',
												topicName: item.name,
												subscriptionName: '',
											},
											'create',
										)
									"
									>Create subscription</ContextMenuItem
								><ContextMenuItem
									class="entity-context-item"
									:disabled="grid.writeBlocked"
									@select="edit(item.target, 'update')"
									>Edit topic</ContextMenuItem
								><ContextMenuItem
									class="entity-context-item entity-context-danger"
									:disabled="grid.writeBlocked"
									@select="edit(item.target, 'delete')"
									>Delete topic</ContextMenuItem
								><ContextMenuItem
									class="entity-context-item"
									:disabled="grid.blocked"
									@select="grid.loadSubscriptions(item.name)"
									>Refresh subscriptions</ContextMenuItem
								></template
							></EventGridMenu
						>
						<div
							v-if="grid.expanded.includes(item.name)"
							role="group"
							class="eg-subscriptions"
						>
							<Button
								v-if="!grid.subscriptions[item.name]"
								size="sm"
								variant="outline"
								:disabled="grid.blocked"
								@click="grid.loadSubscriptions(item.name)"
								>Load subscriptions for {{ item.name }}</Button
							>
							<EventGridMenu
								:disabled="grid.blocked"
								v-for="sub in grid.subscriptions[item.name]?.items"
								:key="sub.name"
								><template #trigger
									><button
										class="eg-node eg-subscription"
										role="treeitem"
										:aria-label="`Event Grid subscription ${sub.name} under ${item.name}`"
										:disabled="grid.blocked"
										@click="grid.inspect(sub.target)"
									>
										<Workflow :size="15" />{{ sub.name
										}}<small
											>{{ sub.deliveryMode ?? 'Delivery mode not supplied' }}
											·
											{{
												sub.provisioningState ?? 'State not supplied'
											}}</small
										>
									</button></template
								><template #default
									><ContextMenuItem
										class="entity-context-item"
										:disabled="grid.blocked"
										@select="grid.inspect(sub.target)"
										>Inspect subscription and filters</ContextMenuItem
									><ContextMenuItem
										class="entity-context-item"
										:disabled="grid.blocked || sub.deliveryMode === 'Push'"
										@select="receiveTarget(sub.target)"
										>Receive events…</ContextMenuItem
									><ContextMenuItem
										class="entity-context-item"
										:disabled="grid.writeBlocked"
										@select="edit(sub.target, 'update')"
										>Edit subscription</ContextMenuItem
									><ContextMenuItem
										class="entity-context-item entity-context-danger"
										:disabled="grid.writeBlocked"
										@select="edit(sub.target, 'delete')"
										>Delete subscription</ContextMenuItem
									><ContextMenuItem
										class="entity-context-item"
										:disabled="grid.blocked"
										@select="grid.loadSubscriptions(item.name)"
										>Refresh subscriptions</ContextMenuItem
									></template
								></EventGridMenu
							>
							<p
								v-if="grid.subscriptions[item.name]?.items.length === 0"
								class="field-hint"
							>
								No subscriptions returned for {{ item.name }}.
							</p>
							<Button
								v-if="grid.subscriptions[item.name]?.continuationToken"
								variant="outline"
								size="sm"
								:disabled="grid.blocked"
								@click="grid.loadSubscriptions(item.name, true)"
								>Load more subscriptions for {{ item.name }}</Button
							>
						</div>
					</div>
					<p v-if="grid.topics && !topics.length" class="field-hint">
						{{
							query
								? 'No loaded topics match this search.'
								: 'No namespace topics returned.'
						}}
					</p>
				</div>
			</div>
			<Button
				v-if="grid.topics?.continuationToken"
				variant="outline"
				:disabled="grid.blocked"
				@click="grid.loadTopics(true)"
				>Load more Event Grid topics</Button
			>
		</template>
		<p v-if="formError || grid.error" class="form-error" role="alert">
			{{ formError || grid.error }}
		</p>
		<section v-if="!grid.inspection && grid.busy" class="nh-working" role="status">
			<p>{{ grid.busy }}…</p>
			<template v-if="job?.code"
				><p>Sign in to continue.</p>
				<p class="device-code">{{ job.code }}</p>
				<Button variant="outline" @click="signIn">Open Microsoft sign-in</Button></template
			><Button variant="outline" @click="grid.cancel()">Cancel Event Grid operation</Button>
		</section>
		<EventGridReceiver
			v-if="connected && receivingTarget"
			:key="eventGridPath(receivingTarget)"
			:target="receivingTarget"
			@close="receivingTarget = undefined"
		/>
		<EventGridPublisher
			v-if="connected && publishingTopic"
			:key="publishingTopic"
			:topic-name="publishingTopic"
			@close="publishingTopic = ''"
		/>
		<EventGridEditor
			v-if="connected && editor"
			:key="eventGridPath(editor.target) + editor.action"
			:target="editor.target"
			:action="editor.action"
			@close="editor = undefined"
		/>
		<Dialog
			:open="connected && !!grid.inspection"
			@update:open="!$event && grid.closeInspection()"
			><DialogContent class="sm:max-w-[920px] eg-inspector" :show-close-button="false"
				><DialogHeader
					><DialogTitle>Event Grid inspection</DialogTitle
					><DialogDescription
						>{{ grid.inspection && eventGridPath(grid.inspection) }} ·
						{{ profile.namespace }}</DialogDescription
					></DialogHeader
				>
				<div class="eg-inspector-scroll">
					<template v-if="grid.details"
						><p class="field-hint">
							Captured {{ new Date(grid.details.capturedAt).toLocaleString() }}
						</p>
						<p class="eg-resource-id">{{ grid.details.resourceId }}</p>
						<dl class="eg-properties">
							<template
								v-for="property in grid.details.properties"
								:key="property.name"
								><dt>{{ property.name }}</dt>
								<dd>{{ property.value }}</dd></template
							>
						</dl>
						<section
							v-if="grid.details.target.kind === 'subscription'"
							aria-label="Event Grid subscription filters"
						>
							<h3>Included event types</h3>
							<p v-if="grid.details.filters?.includedEventTypes == null">
								Not specified · all default event types.
							</p>
							<p v-else-if="!grid.details.filters.includedEventTypes.length">
								Azure returned an empty event-type list.
							</p>
							<ul v-else>
								<li
									v-for="type in grid.details.filters.includedEventTypes"
									:key="type"
								>
									{{ type }}
								</li>
							</ul>
							<h3>Advanced filters</h3>
							<p v-if="!grid.details.filters?.filters.length">
								No advanced filters returned.
							</p>
							<div
								v-for="(filter, index) in grid.details.filters?.filters"
								:key="index"
								class="eg-filter"
							>
								<strong
									>{{ filter.key ?? 'Key not supplied' }} ·
									{{ filter.operatorType ?? 'Operator not supplied' }}</strong
								><span v-if="!filter.known" class="form-warning"
									>Unknown operator · inspection only</span
								><JsonBody :text="filter.definitionJson" />
							</div>
							<p class="field-hint">
								These are Azure's configured filters. This view does not evaluate
								events or edit filter behavior.
							</p>
						</section>
						<section
							v-if="grid.details.deliveryJson"
							aria-label="Event Grid delivery settings"
						>
							<h3>Delivery settings</h3>
							<JsonBody :text="grid.details.deliveryJson" />
						</section>
						<p v-if="grid.details.warning" class="form-warning">
							{{ grid.details.warning }}
						</p>
					</template>
					<template v-if="grid.busy"
						><p role="status">{{ grid.busy }}…</p>
						<div v-if="job?.code">
							<p>Sign in to continue.</p>
							<p class="device-code">{{ job.code }}</p>
							<Button variant="outline" @click="signIn"
								>Open Microsoft sign-in</Button
							>
						</div></template
					>
					<p v-if="grid.error" class="form-error" role="alert">{{ grid.error }}</p>
				</div>
				<DialogFooter
					><Button
						v-if="grid.inspection?.kind === 'subscription'"
						:disabled="grid.blocked"
						@click="receiveTarget(grid.inspection)"
						>Receive events…</Button
					><Button
						v-if="grid.inspection?.kind === 'topic'"
						:disabled="grid.writeBlocked"
						@click="publishTopic(grid.inspection.topicName)"
						>Publish CloudEvents…</Button
					><Button
						v-if="grid.inspection && grid.inspection.kind !== 'namespace'"
						:disabled="grid.writeBlocked"
						@click="edit(grid.inspection, 'update')"
						>Edit resource</Button
					><Button
						v-if="grid.inspection && grid.inspection.kind !== 'namespace'"
						variant="destructive"
						:disabled="grid.writeBlocked"
						@click="edit(grid.inspection, 'delete')"
						>Delete resource</Button
					><Button v-if="grid.busy" variant="outline" @click="grid.cancel()"
						>Cancel Event Grid operation</Button
					><Button
						variant="outline"
						:disabled="grid.blocked"
						@click="grid.refreshInspection()"
						>Refresh inspection</Button
					><Button variant="outline" @click="grid.closeInspection()"
						>Close Event Grid inspection</Button
					></DialogFooter
				>
			</DialogContent></Dialog
		>
	</section>
</template>
<style>
.event-grid-explorer {
	display: flex;
	flex-direction: column;
	gap: 16px;
	min-width: 0;
}
.eg-setup {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 20px;
	border: 1px solid var(--border);
	border-radius: 12px;
	background: var(--card);
	max-width: 900px;
}
.eg-setup label,
.eg-search {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.eg-setup > button {
	align-self: flex-start;
}
.eg-search {
	max-width: 400px;
}
.eg-tree {
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 12px;
	background: var(--card);
	overflow: auto;
}
.eg-node {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px;
	text-align: left;
	border-radius: 6px;
	min-width: 0;
	overflow-wrap: anywhere;
}
.eg-node:hover {
	background: var(--muted);
}
.eg-node small {
	color: var(--muted-foreground);
	font-size: 11px;
}
.eg-topic-row {
	display: flex;
	align-items: center;
	gap: 4px;
}
.eg-topic-row > .eg-node {
	flex: 1;
}
.eg-topics {
	padding-left: 18px;
}
.eg-subscriptions {
	margin: 4px 0 14px 44px;
	border-left: 1px solid var(--border);
	padding-left: 12px;
}
.eg-inspector {
	display: flex;
	flex-direction: column;
	max-height: 90vh;
	gap: 16px;
}
.eg-inspector-scroll {
	overflow: auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 16px;
}
.eg-inspector-scroll > * {
	flex-shrink: 0;
}
.eg-resource-id {
	overflow-wrap: anywhere;
	font-family: var(--font-mono);
	font-size: 11px;
}
.eg-properties {
	display: grid;
	grid-template-columns: minmax(120px, 1fr) 2fr;
	gap: 8px;
	font-size: 13px;
}
.eg-properties dt {
	color: var(--muted-foreground);
}
.eg-properties dd {
	overflow-wrap: anywhere;
}
.eg-filter {
	margin: 10px 0;
}
.eg-filter strong {
	font-size: 13px;
}
.eg-filter .form-warning {
	display: block;
}
.eg-inspector .body-preview {
	max-height: 300px;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.eg-inspector h3 {
	font-weight: 600;
	margin-bottom: 8px;
}
.eg-inspector ul {
	list-style: disc;
	padding-left: 20px;
}
@media (max-width: 900px) {
	.eg-node {
		flex-wrap: wrap;
	}
	.eg-node small {
		width: 100%;
	}
	.eg-topic-row {
		flex-wrap: wrap;
	}
}
</style>
