<script setup lang="ts">
import LoadingIndicator from '@/shared/components/LoadingIndicator.vue'
import EntitySplitView from '../../../shared/components/EntitySplitView.vue'
import WorkspaceTabs from '../../../shared/components/WorkspaceTabs.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import EventOperationStatistics from './EventOperationStatistics.vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import EventHubListener from './EventHubListener.vue'
import EventHubInspector from './EventHubInspector.vue'
import EventHubStatistics from './EventHubStatistics.vue'
import { useEventListener } from '@/features/event-hubs/stores/event-hubs-listener'
import EventHubComposer from './EventHubComposer.vue'
import EventHubAdministration from './EventHubAdministration.vue'
import EventHubPolicies from './EventHubPolicies.vue'
import { MessagingConfiguration } from '@/features/resource-configuration'
import EventAdminMenu from './EventAdminMenu.vue'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useWorkspace } from '@/shared/workspace/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import {
	eventHubsConnectSchema,
	consumerGroupSchema,
	eventHubReadSchema,
	eventHubNameSchema,
	type EventPosition,
	type EventSummary,
} from '@shared/contracts/event-hubs/core'
import type { Profile } from '@shared/contracts'
const props = defineProps<{ profile: Profile }>()
const emit = defineEmits<{ settings: []; remove: [] }>()
const eh = useEventHubs(),
	workspace = useWorkspace(),
	layout = useWorkspaceLayout()
const openViews = computed(() =>
	eh.tabs.map((tab) => ({
		id: tab.id,
		label:
			tab.hubName +
			(tab.partitionId ? ' / ' + tab.consumerGroup + ' / ' + tab.partitionId : ''),
	})),
)
const isIot = computed(() => props.profile.service === 'iot-hub')
const serviceName = computed(() => (isIot.value ? 'IoT Hub' : 'Event Hubs'))
const iotGroup = ref('$Default')
const connected = computed(() => eh.connection?.profileId === props.profile.id)
const composer = ref<InstanceType<typeof EventHubComposer>>()
const sendOnly = ref(false)
const listenerPanel = ref<InstanceType<typeof EventHubListener>>()
const listener = useEventListener()
const statisticsPanel = ref<InstanceType<typeof EventHubStatistics>>()
const administration = ref<InstanceType<typeof EventHubAdministration>>()
const policies = ref<InstanceType<typeof EventHubPolicies>>()
function adminAction(action: string, hubName: string, name: string) {
	if (action === 'statistics') {
		statisticsPanel.value?.open(hubName)
		return
	}
	if (action === 'listen') {
		listenerPanel.value?.open(hubName, name || '$Default')
		return
	}
	if (action === 'policies') void policies.value?.show(hubName)
	else
		void administration.value?.show(
			action.endsWith('hub') ? 'hub' : 'group',
			action.startsWith('create')
				? 'create'
				: action.startsWith('delete')
					? 'delete'
					: 'update',
			action.endsWith('hub') ? '' : hubName,
			action.startsWith('create') ? '' : action.endsWith('hub') ? hubName : name,
		)
}
const knownHub = ref(''),
	managementEnabled = ref(false),
	resourceId = ref(''),
	tenantId = ref(''),
	clientId = ref(''),
	hubToOpen = ref(''),
	filter = ref('')
const positionKind = ref('earliest'),
	positionValue = ref(''),
	inclusive = ref(true),
	maxEvents = ref(25),
	maxSeconds = ref(10)
const readSettingsOpen = ref(true)
type ReadSettings = {
	kind: string
	value: string
	inclusive: boolean
	maxEvents: number
	maxSeconds: number
	open: boolean
}
const tabSettings = new Map<string, ReadSettings>()
watch(
	() => eh.activeTabId,
	(id, previous) => {
		if (previous && eh.tabs.some((tab) => tab.id === previous))
			tabSettings.set(previous, {
				kind: positionKind.value,
				value: positionValue.value,
				inclusive: inclusive.value,
				maxEvents: maxEvents.value,
				maxSeconds: maxSeconds.value,
				open: readSettingsOpen.value,
			})
		for (const key of tabSettings.keys())
			if (!eh.tabs.some((tab) => tab.id === key)) tabSettings.delete(key)
		const settings = tabSettings.get(id)
		positionKind.value = settings?.kind ?? 'earliest'
		positionValue.value = settings?.value ?? ''
		inclusive.value = settings?.inclusive ?? true
		maxEvents.value = settings?.maxEvents ?? 25
		maxSeconds.value = settings?.maxSeconds ?? 10
		readSettingsOpen.value = settings?.open ?? true
		inspector.value = false
	},
)
watch(
	() => eh.result,
	(value) => {
		if (value) readSettingsOpen.value = false
	},
)
const inspector = ref(false),
	elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
watch(
	() => eh.reading,
	(active) => {
		clearInterval(timer)
		if (active) {
			const started = Date.now()
			elapsed.value = 0
			timer = setInterval(() => {
				elapsed.value = Date.now() - started
			}, 250)
		}
	},
	{ immediate: true },
)
onBeforeUnmount(() => clearInterval(timer))
watch(
	() => props.profile.id,
	() => {
		iotGroup.value = '$Default'
		knownHub.value = ''
		managementEnabled.value = false
		resourceId.value = ''
		tenantId.value = props.profile.tenantId
		clientId.value = props.profile.clientId
		inspector.value = false
	},
	{ immediate: true },
)
watch(
	() => eh.connection?.connectionId,
	() => {
		inspector.value = false
	},
)
const connectionInput = computed(() => ({
	id: crypto.randomUUID(),
	profileId: props.profile.id,
	access: sendOnly.value ? ('send' as const) : ('read' as const),
	hubName: knownHub.value,
	management: managementEnabled.value
		? { resourceId: resourceId.value, tenantId: tenantId.value, clientId: clientId.value }
		: null,
}))
const connectionValid = computed(() =>
	isIot.value
		? consumerGroupSchema.safeParse(iotGroup.value).success
		: eventHubsConnectSchema.safeParse(connectionInput.value).success,
)
const position = computed((): EventPosition | undefined => {
	if (positionKind.value === 'earliest' || positionKind.value === 'latest')
		return { kind: positionKind.value }
	if (positionKind.value === 'time') return { kind: 'time', value: positionValue.value }
	if (positionKind.value === 'sequence' || positionKind.value === 'offset')
		return { kind: positionKind.value, value: positionValue.value, inclusive: inclusive.value }
})
const canRead = computed(
	() =>
		eventHubReadSchema.safeParse({
			id: crypto.randomUUID(),
			connectionId: eh.connection?.connectionId,
			hubName: eh.hubName,
			partitionId: eh.partitionId,
			consumerGroup: eh.consumerGroup,
			position: position.value,
			maxEvents: maxEvents.value,
			maxSeconds: maxSeconds.value,
		}).success,
)
const visibleHubs = computed(() =>
	eh.hubs.items.filter((item) => item.name.toLowerCase().includes(filter.value.toLowerCase())),
)
const treeGroups = computed(() =>
	Array.from(new Set([eh.consumerGroup, ...eh.groups.items.map((item) => item.name)])),
)
const duration = computed(
	() => eh.result?.elapsedMs ?? Math.max(elapsed.value, eh.readJob?.eventHubRead?.elapsedMs ?? 0),
)
const received = computed(() => eh.result?.received ?? eh.readJob?.eventHubRead?.received ?? 0)
async function connect() {
	if (isIot.value) {
		const profileId = props.profile.id,
			group = iotGroup.value
		if (!consumerGroupSchema.safeParse(group).success) return
		await eh.connectIot(profileId)
		if (eh.connection?.profileId === profileId) eh.consumerGroup = group
		return
	}
	const parsed = eventHubsConnectSchema.safeParse(connectionInput.value)
	if (parsed.success) await eh.connect(parsed.data)
}
async function read() {
	if (position.value && canRead.value)
		await eh.read({
			position: position.value,
			maxEvents: maxEvents.value,
			maxSeconds: maxSeconds.value,
		})
}
async function inspect(item: EventSummary) {
	inspector.value = true
	await eh.inspect(item)
}
function continueFromLast() {
	const last = eh.result?.items.at(-1)
	if (!last || !eh.result) return
	readSettingsOpen.value = true
	positionKind.value = 'offset'
	positionValue.value = last.offset
	inclusive.value = false
}
</script>
<template>
	<section
		class="service-bus-workspace event-hubs-explorer"
		:aria-label="`${serviceName} explorer`"
	>
		<div class="explorer-heading">
			<div>
				<strong>{{
					connected ? `${serviceName} connected` : `Connect to ${serviceName}`
				}}</strong>
				<p class="explorer-note">
					{{
						isIot
							? 'Read device-to-cloud telemetry from the built-in Event Hubs-compatible endpoint.'
							: 'Compose events and inspect retained streams by partition.'
					}}
				</p>
			</div>
			<div class="explorer-actions">
				<Button variant="outline" size="sm" :disabled="!!eh.busy" @click="emit('settings')"
					>Connection settings</Button
				><Button
					v-if="!connected"
					variant="ghost"
					size="sm"
					:disabled="!!eh.busy"
					@click="emit('remove')"
					>Remove connection</Button
				><Button
					v-if="connected"
					variant="outline"
					size="sm"
					:disabled="!!eh.busy"
					@click="eh.disconnect"
					>Disconnect {{ serviceName }}</Button
				>
			</div>
		</div>
		<p v-if="eh.error" role="alert" class="error-banner">{{ eh.error }}</p>
		<LoadingIndicator v-if="eh.busy" :label="eh.reading ? 'Retrieving events…' : `${eh.busy}…`">
			<Button variant="outline" size="sm" @click="eh.cancel">{{
				eh.reading ? 'Cancel event read' : `Cancel ${serviceName} operation`
			}}</Button>
		</LoadingIndicator>
		<form v-if="!connected" class="eh-connect" @submit.prevent="connect">
			<template v-if="isIot">
				<p class="explorer-note">
					The compatible endpoint and entity name come from this connection's saved
					string. Choose an existing consumer group; create groups in IoT Hub → Built-in
					endpoints.
				</p>
				<label
					>Consumer group<Input
						v-model="iotGroup"
						aria-label="IoT Hub consumer group"
						maxlength="50"
						:disabled="!!eh.busy"
				/></label>
			</template>
			<template v-else>
				<label
					>Known Event Hub name<Input
						v-model="knownHub"
						aria-label="Known Event Hub name"
						maxlength="256"
						placeholder="e.g. telemetry"
				/></label>
				<p class="explorer-note">
					Open a known hub using this profile’s SAS or Entra data identity. For a
					hub-scoped connection string, enter its EntityPath. Data access needs Listen or
					Event Hubs Data Receiver permission.
				</p>
				<label class="check-row"
					><input v-model="sendOnly" type="checkbox" />Connect for sending only</label
				>
				<p v-if="sendOnly" class="explorer-note">
					Uses Send or Event Hubs Data Sender permission. Reading is disabled for this
					connection.
				</p>
				<label class="check-row"
					><input v-model="managementEnabled" type="checkbox" />Browse hubs and consumer
					groups with Entra management access</label
				>
				<template v-if="managementEnabled">
					<p class="explorer-note">
						Namespace browsing requires ARM read permission. This sign-in is separate
						from SAS event access. Leave the known hub empty to browse first.
					</p>
					<label
						>Event Hubs namespace resource ID<Input
							v-model="resourceId"
							aria-label="Event Hubs namespace resource ID"
							placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.EventHub/namespaces/…"
					/></label>
					<div class="eh-fields">
						<label
							>Management tenant ID<Input
								v-model="tenantId"
								aria-label="Event Hubs management tenant" /></label
						><label
							>Public client application ID<Input
								v-model="clientId"
								aria-label="Event Hubs management client"
						/></label>
					</div>
				</template>
			</template>
			<Button type="submit" :disabled="!workspace.ready || !!eh.busy || !connectionValid"
				>Connect {{ serviceName }}</Button
			>
		</form>
		<template v-else>
			<div v-if="!isIot" class="explorer-actions">
				<MessagingConfiguration
					service="event-hubs"
					:connection="eh"
					:scope="
						eh.hubName
							? { kind: 'hub', name: eh.hubName, parentKind: null, parentName: null }
							: null
					"
				/>
				<Button
					variant="outline"
					size="sm"
					:disabled="!!eh.busy || !eh.connection?.managementAvailable"
					@click="administration?.show('hub', 'create')"
					>Create Event Hub…</Button
				>
				<Button
					variant="outline"
					size="sm"
					:disabled="!!eh.busy || !eh.connection?.managementAvailable"
					@click="policies?.show('')"
					>Namespace SAS policies…</Button
				>
				<Button
					v-if="eh.hubName"
					variant="outline"
					size="sm"
					:disabled="!!eh.busy || !eh.connection?.managementAvailable"
					@click="administration?.show('hub', 'update', '', eh.hubName)"
					>Edit Event Hub…</Button
				>
				<Button
					v-if="eh.hubName"
					variant="outline"
					size="sm"
					:disabled="!!eh.busy || !eh.connection?.managementAvailable"
					@click="administration?.show('group', 'create', eh.hubName)"
					>Create consumer group…</Button
				>
			</div>
			<Button
				v-if="eh.hubName && !isIot"
				variant="outline"
				:disabled="!!eh.busy && !eh.sending"
				@click="composer?.open()"
				>{{ eh.sendId ? 'Event send result…' : 'Send events…' }}</Button
			>
			<p v-if="eh.connection?.access === 'send'" class="explorer-note">
				Connected for sending. Reconnect in read mode to read events.
			</p>
			<p class="explorer-note">
				{{
					isIot
						? 'Built-in endpoint · read only. Use an existing dedicated consumer group. Device traffic must be routed to this endpoint; an idle read does not prove that no devices are sending.'
						: eh.connection?.managementAvailable
							? 'Namespace browsing enabled. Opening partitions also checks the profile’s data access.'
							: 'Known-hub access. Reconnect with Entra management access to list all hubs and consumer groups.'
				}}
			</p>
			<EntitySplitView storage-key="commander-event-hubs-entities-v1"
				><template #tree>
					<aside
						v-show="layout.treeVisible"
						class="entity-browser eh-tree"
						aria-label="Event Hubs entities"
					>
						<Input
							v-if="!isIot"
							v-model="filter"
							aria-label="Filter Event Hubs"
							placeholder="Filter loaded hubs"
						/>
						<Button
							v-if="eh.connection?.managementAvailable"
							variant="outline"
							size="sm"
							:disabled="!!eh.busy"
							@click="eh.listHubs()"
							>Refresh hubs</Button
						>
						<p v-if="isIot" class="explorer-note">
							Built-in endpoint · right-click to listen
						</p>
						<EventAdminMenu kind="namespace" @action="adminAction"
							><Button variant="ghost" size="sm" class="hub-button"
								>Event Hubs · right-click for actions</Button
							></EventAdminMenu
						>
						<div role="tree" aria-label="Event Hubs tree">
							<div
								v-for="item in visibleHubs"
								:key="item.name"
								role="treeitem"
								:aria-expanded="eh.hubName === item.name"
								:aria-label="`Event Hub ${item.name}`"
							>
								<EventAdminMenu
									kind="hub"
									:hub-name="item.name"
									@action="adminAction"
									><Button
										variant="ghost"
										:disabled="!!eh.busy"
										class="hub-button"
										@click="eh.selectHub(item.name)"
										>{{ eh.hubName === item.name ? '▾' : '▸' }}
										{{ item.name }}</Button
									></EventAdminMenu
								>
								<div v-if="eh.hubName === item.name" role="group" class="eh-branch">
									<details
										v-for="group in treeGroups"
										:key="group"
										:open="group === eh.consumerGroup"
									>
										<EventAdminMenu
											kind="group"
											:hub-name="item.name"
											:name="group"
											@action="adminAction"
											><summary
												:title="
													eh.groups.items.find(
														(item) => item.name === group,
													)?.userMetadata ?? undefined
												"
											>
												{{ group }}
											</summary></EventAdminMenu
										>
										<div role="group">
											<EventAdminMenu
												v-for="part in eh.hub?.partitionIds ?? []"
												:key="part"
												kind="partition"
												:hub-name="item.name"
												:name="group"
												:partition-id="part"
												@action="adminAction"
												><Button
													variant="ghost"
													:disabled="!!eh.busy"
													:aria-pressed="
														eh.partitionId === part &&
														eh.consumerGroup === group
													"
													:aria-label="`${item.name} ${group} partition ${part}`"
													@click="eh.selectPartition(part, group)"
													>Partition {{ part }}</Button
												></EventAdminMenu
											>
										</div>
									</details>
									<Button
										v-if="eh.connection?.managementAvailable"
										variant="outline"
										size="sm"
										:disabled="!!eh.busy"
										@click="eh.listGroups()"
										>Load consumer groups</Button
									>
									<Button
										v-if="eh.groups.continuationToken"
										variant="outline"
										size="sm"
										:disabled="!!eh.busy"
										@click="eh.listGroups(true)"
										>More consumer groups</Button
									>
								</div>
							</div>
						</div>
						<Button
							v-if="eh.hubs.continuationToken"
							variant="outline"
							size="sm"
							:disabled="!!eh.busy"
							@click="eh.listHubs(true)"
							>More hubs</Button
						>
						<form
							v-if="!isIot"
							class="eh-known"
							@submit.prevent="eh.selectHub(hubToOpen)"
						>
							<label
								>Open another hub<Input
									v-model="hubToOpen"
									aria-label="Open Event Hub by name"
									maxlength="256" /></label
							><Button
								variant="outline"
								size="sm"
								type="submit"
								:disabled="
									!!eh.busy || !eventHubNameSchema.safeParse(hubToOpen).success
								"
								>Open hub</Button
							>
						</form>
					</aside>
				</template>
				<div
					class="entity-workspace eh-workspace"
					id="event-tab-content"
					role="tabpanel"
					aria-label="Event workspace"
				>
					<WorkspaceTabs
						:items="openViews"
						:active="eh.activeTabId"
						:disabled="!!eh.busy"
						label="Open event views"
						close-label="Close event tab"
						controls="event-tab-content"
						@select="eh.activateTab"
						@close="eh.closeTab"
					/>
					<p v-if="eh.urlNotice" role="status">{{ eh.urlNotice }}</p>
					<p v-if="!eh.hubName" class="explorer-empty">
						Choose an Event Hub from the tree.
					</p>
					<template v-else>
						<div class="explorer-heading">
							<h2>{{ eh.hubName }}</h2>
							<span v-if="eh.hub" class="explorer-note"
								>{{ eh.hub.partitionIds.length }} partitions · Created
								{{ eh.hub.createdAt }}</span
							>
						</div>
						<p v-if="!eh.partitionId" class="explorer-empty">
							Choose a partition under a consumer group to inspect its retained range
							and read events.
						</p>
						<template v-else>
							<h3>Partition {{ eh.partitionId }}</h3>
							<dl v-if="eh.partition" class="eh-metadata">
								<div>
									<dt>Retained range</dt>
									<dd>
										{{
											eh.partition.isEmpty
												? 'Empty'
												: `${eh.partition.beginningSequence} – ${eh.partition.lastSequence}`
										}}
									</dd>
								</div>
								<div>
									<dt>Last offset</dt>
									<dd>{{ eh.partition.lastOffset ?? '—' }}</dd>
								</div>
								<div>
									<dt>Last enqueued</dt>
									<dd>{{ eh.partition.lastEnqueuedTime ?? '—' }}</dd>
								</div>
							</dl>
							<details
								class="eh-read-settings"
								:open="readSettingsOpen"
								@toggle="
									readSettingsOpen = ($event.target as HTMLDetailsElement).open
								"
							>
								<summary>
									Configure event read
									<span class="explorer-note"
										>· {{ eh.consumerGroup }} · {{ maxEvents }} events ·
										{{ maxSeconds }}s</span
									>
								</summary>
								<form class="eh-read" @submit.prevent="read">
									<div class="eh-fields">
										<label
											>Consumer group<Input
												v-model="eh.consumerGroup"
												aria-label="Read consumer group"
												:disabled="!!eh.busy"
												maxlength="50" /></label
										><label
											>Start position<select
												v-model="positionKind"
												aria-label="Event start position"
												:disabled="!!eh.busy"
											>
												<option value="earliest">
													Earliest retained event
												</option>
												<option value="latest">New events only</option>
												<option value="sequence">Sequence number</option>
												<option value="offset">Offset</option>
												<option value="time">Enqueued time</option>
											</select></label
										>
									</div>
									<template
										v-if="['sequence', 'offset', 'time'].includes(positionKind)"
										><label
											>{{
												positionKind === 'time'
													? 'ISO date and time with timezone'
													: 'Exact position'
											}}<Input
												v-model="positionValue"
												aria-label="Event position value"
												:disabled="!!eh.busy"
												:placeholder="
													positionKind === 'time'
														? '2026-10-11T10:00:00Z'
														: ''
												" /></label
										><label v-if="positionKind !== 'time'" class="check-row"
											><input
												v-model="inclusive"
												type="checkbox"
												:disabled="!!eh.busy"
											/>Include the event at this position</label
										></template
									>
									<div class="eh-fields">
										<label
											>Event count<Input
												v-model.number="maxEvents"
												aria-label="Event read count"
												type="number"
												min="1"
												max="100"
												:disabled="!!eh.busy" /></label
										><label
											>Time limit (seconds)<Input
												v-model.number="maxSeconds"
												aria-label="Event read time limit"
												type="number"
												min="1"
												max="300"
												:disabled="!!eh.busy"
										/></label>
									</div>
									<p class="explorer-note">
										Reading does not delete events or save checkpoints. This
										reader does not request exclusive ownership. Use a dedicated
										consumer group for testing. A new read replaces the previous
										inspection buffer.
									</p>
									<Button
										type="submit"
										:disabled="
											!!eh.busy ||
											!canRead ||
											!!eh.result?.cleanupWarning ||
											eh.connection?.access === 'send'
										"
										>Read events</Button
									>
								</form>
							</details>
						</template>
					</template>
					<div class="explorer-actions">
						<Button
							variant="outline"
							:disabled="!!eh.busy || !eh.hubName"
							@click="statisticsPanel?.open()"
							>Statistics…</Button
						>
						<Button
							variant="outline"
							:disabled="
								(!listener.running && !!eh.busy) ||
								eh.connection?.access === 'send' ||
								!eh.hubName
							"
							@click="listenerPanel?.open()"
							>{{
								listener.running
									? 'Listener progress…'
									: 'Listen to all partitions…'
							}}</Button
						><Button
							v-if="listener.operationId && !listener.running"
							variant="outline"
							:disabled="!!eh.busy"
							@click="listenerPanel?.open()"
							>Listener result…</Button
						>
					</div>
					<EventHubStatistics ref="statisticsPanel" />
					<section v-if="eh.readId" aria-label="Event read results" class="eh-results">
						<p v-if="eh.reading" role="status">
							{{ received }} events read · {{ (duration / 1000).toFixed(1) }} seconds
							·
							{{ eh.readJob?.eventHubRead?.phase ?? 'starting' }}
						</p>
						<p v-if="eh.result" role="status">{{ eh.result.summary }}</p>
						<EventOperationStatistics
							:statistics="
								eh.result?.statistics ?? eh.readJob?.eventHubRead?.statistics
							"
							:elapsed-ms="duration"
							label="Read statistics"
						/>
						<Button
							v-if="eh.result?.items.some((i) => i.snapshotId)"
							variant="outline"
							:disabled="!!eh.busy"
							@click="
								listener.exportEvents(
									eh.result.items.flatMap((i) =>
										i.snapshotId ? [i.snapshotId] : [],
									),
								)
							"
							>Export read events…</Button
						>
						<p v-if="listener.notice" role="status">{{ listener.notice }}</p>
						<p v-if="eh.result" class="explorer-note">
							{{ eh.result.hubName }} / {{ eh.result.consumerGroup }} / Partition
							{{ eh.result.partitionId }} · {{ eh.result.status }} ·
							{{ (duration / 1000).toFixed(1) }} seconds
						</p>
						<p v-if="eh.result?.cleanupWarning" class="inspector-warning">
							{{ eh.result.cleanupWarning }}
						</p>
						<template v-if="eh.interrupted"
							><p class="inspector-warning">
								The read response was interrupted. Recover the retained result or
								explicitly read again from your chosen position.
							</p>
							<Button variant="outline" :disabled="!!eh.busy" @click="eh.recoverRead"
								>Recover event read result</Button
							></template
						>
						<Button
							v-if="
								eh.result?.items.length &&
								eh.result.hubName === eh.hubName &&
								eh.result.partitionId === eh.partitionId &&
								eh.result.consumerGroup === eh.consumerGroup
							"
							variant="outline"
							size="sm"
							:disabled="!!eh.busy"
							@click="continueFromLast"
							>Use position after last event</Button
						>
						<div class="eh-table">
							<table v-if="eh.result?.items.length" class="message-table">
								<thead>
									<tr>
										<th>Sequence</th>
										<th>Offset</th>
										<th>Enqueued</th>
										<th>Bytes</th>
										<th>Inspect</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="item in eh.result.items" :key="item.sequenceNumber">
										<td>{{ item.sequenceNumber }}</td>
										<td>{{ item.offset }}</td>
										<td>{{ item.enqueuedTime }}</td>
										<td>{{ item.bodySize }}</td>
										<td>
											<Button
												v-if="item.snapshotId"
												variant="ghost"
												size="sm"
												:disabled="!!eh.busy"
												:aria-label="`Inspect event ${item.sequenceNumber}`"
												@click="inspect(item)"
												>Inspect</Button
											><span v-else>{{ item.warning }}</span>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</section>
				</div>
			</EntitySplitView>
		</template>
	</section>
	<EventHubComposer v-if="!isIot" ref="composer" />
	<EventHubListener ref="listenerPanel" @inspect="inspect" />
	<EventHubAdministration v-if="!isIot" ref="administration" />
	<EventHubPolicies v-if="!isIot" ref="policies" />
	<EventHubInspector v-model:open="inspector" />
</template>
<style scoped>
.eh-connect,
.eh-read {
	display: grid;
	gap: 0.8rem;
	max-width: 850px;
}
.eh-connect {
	padding-top: 1rem;
}
.eh-fields {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 1rem;
}
label {
	display: block;
}
.check-row {
	display: flex;
	gap: 0.6rem;
	align-items: flex-start;
}
select {
	width: 100%;
	border: 1px solid var(--border);
	background: var(--background);
	color: var(--foreground);
	border-radius: 0.4rem;
	padding: 0.5rem;
}
.eh-tree {
	padding: 1rem;
	overflow: auto;
}
.hub-button {
	justify-content: start;
	width: 100%;
}
.eh-branch {
	padding-left: 1rem;
	border-left: 1px solid var(--border);
}
.eh-branch [role='group'] {
	display: flex;
	flex-direction: column;
	align-items: start;
}
summary {
	cursor: pointer;
	padding: 0.5rem 0;
	overflow-wrap: anywhere;
}
.eh-known {
	border-top: 1px solid var(--border);
	padding-top: 1rem;
	margin-top: 1rem;
}
.eh-workspace {
	min-width: 0;
}
.eh-read-settings {
	padding: 0.4rem 0;
}
.eh-read-settings > summary {
	border-top: 1px solid var(--border);
	margin-bottom: 0.5rem;
}
.eh-results {
	margin-top: 1.5rem;
}
.eh-table {
	overflow: auto;
	max-height: 42vh;
}
table {
	width: 100%;
	text-align: left;
}
th,
td {
	padding: 0.5rem;
	border-bottom: 1px solid var(--border);
}
</style>
