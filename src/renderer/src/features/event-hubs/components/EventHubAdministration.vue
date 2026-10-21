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
import PropertyTable from '../../../shared/components/PropertyTable.vue'
import EventAdminFeedback from './EventAdminFeedback.vue'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventHubsAdmin } from '@/features/event-hubs/stores/event-hubs-admin'
import {
	defaultEventHubSettings,
	eventAdminChangeSchema,
	eventAdminConfirmation,
	eventAdminPath,
	type EventAdminDetails,
	type EventAdminTarget,
	type EventHubSettings,
	type EventCapture,
} from '@shared/contracts/event-hubs/administration'
const eh = useEventHubs(),
	admin = useEventHubsAdmin()
const visible = ref(false),
	kind = ref<'hub' | 'group'>('hub'),
	action = ref<'create' | 'update' | 'delete'>('create'),
	name = ref(''),
	parent = ref(''),
	current = ref<EventAdminDetails>(),
	settings = ref<EventHubSettings>(defaultEventHubSettings()),
	metadata = ref(''),
	acknowledged = ref(false),
	confirmation = ref(''),
	finished = ref(false)
const target = computed<EventAdminTarget>(() =>
	kind.value === 'hub'
		? { kind: 'hub', name: name.value }
		: { kind: 'group', hubName: parent.value, name: name.value },
)
const captureMode = computed({
	get: () => settings.value.capture.mode,
	set: (mode: EventCapture['mode']) => {
		settings.value.capture =
			mode === 'configure'
				? {
						mode,
						intervalSeconds: 300,
						sizeBytes: 314572800,
						skipEmpty: true,
						storageAccountResourceId: '',
						blobContainer: '',
						archiveNameFormat:
							'{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}',
						identity: 'none',
						userAssignedIdentity: '',
					}
				: { mode }
	},
})
const phrase = computed(() => eventAdminConfirmation(action.value, target.value, null))
const writable = computed(
	() =>
		action.value === 'create' ||
		(!!current.value &&
			(action.value === 'delete' ||
				(kind.value === 'hub'
					? !!current.value.hub
					: current.value.userMetadata !== null))),
)
const input = computed(() => ({
	id: crypto.randomUUID(),
	connectionId: eh.connection?.connectionId,
	target: target.value,
	action: action.value,
	expectedRevision: action.value === 'create' ? null : (current.value?.revision ?? null),
	settings: kind.value === 'hub' && action.value !== 'delete' ? settings.value : null,
	userMetadata: kind.value === 'group' && action.value !== 'delete' ? metadata.value : null,
	rights: null,
	keyType: null,
	acknowledged: acknowledged.value,
	confirmation: confirmation.value,
}))
const parsed = computed(() => eventAdminChangeSchema.safeParse(input.value))
const maxPartitions = computed(() =>
	admin.context?.tier === 'Premium' ? 100 : admin.context?.tier === 'Dedicated' ? 1024 : 32,
)
const maxRetention = computed(() =>
	admin.context?.tier === 'Basic' ? 24 : admin.context?.tier === 'Standard' ? 168 : 2160,
)
watch(
	[settings, metadata, name, parent, kind, action],
	() => {
		acknowledged.value = false
		confirmation.value = ''
	},
	{ deep: true, flush: 'sync' },
)
watch(
	() => settings.value.cleanupPolicy,
	(policy) => {
		if (action.value === 'create') {
			settings.value.retentionHours = policy === 'Compact' ? null : 24
			settings.value.tombstoneHours = policy === 'Delete' ? null : 24
			settings.value.minCompactionLagMinutes = policy === 'Delete' ? null : 0
		}
	},
)
watch(
	() => eh.connection?.connectionId,
	() => {
		visible.value = false
		current.value = undefined
		acknowledged.value = false
		finished.value = false
	},
	{ flush: 'sync' },
)
async function load() {
	const details = await admin.get(target.value)
	if (details && visible.value) {
		current.value = details
		if (details.hub) settings.value = structuredClone(details.hub)
		metadata.value = details.userMetadata ?? ''
		acknowledged.value = false
		confirmation.value = ''
	}
}
async function show(
	resource: 'hub' | 'group',
	mode: 'create' | 'update' | 'delete',
	hubName = '',
	resourceName = '',
) {
	if (eh.busy) return
	kind.value = resource
	action.value = mode
	parent.value = hubName
	name.value = resourceName
	current.value = undefined
	settings.value = defaultEventHubSettings()
	metadata.value = ''
	acknowledged.value = false
	confirmation.value = ''
	finished.value = false
	visible.value = true
	await admin.loadContext()
	if (mode !== 'create') await load()
}
async function submit() {
	if (!parsed.value.success || admin.blocked || !writable.value) return
	const result = await admin.change(parsed.value.data)
	acknowledged.value = false
	confirmation.value = ''
	if (result?.status === 'confirmed') finished.value = true
}
function close(value: boolean) {
	if (!eh.busy) visible.value = value
}
defineExpose({ show })
</script>
<template>
	<Dialog :open="visible" @update:open="close"
		><DialogContent
			class="message-inspection-dialog event-admin-dialog"
			:show-close-button="!eh.busy"
			@escape-key-down="eh.busy && $event.preventDefault()"
			@interact-outside="eh.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle
					>{{ action === 'create' ? 'Create' : action === 'delete' ? 'Delete' : 'Edit' }}
					{{ kind === 'hub' ? 'Event Hub' : 'consumer group' }}</DialogTitle
				><DialogDescription
					>{{ eh.connection?.namespace }}{{ parent ? ' / ' + parent : '' }} ·
					{{ admin.context?.tier ?? 'Management access' }}. Changes use your Entra
					management identity.</DialogDescription
				></DialogHeader
			>
			<EventAdminFeedback />
			<template v-if="!finished">
				<div class="admin-fields">
					<label
						>{{ kind === 'hub' ? 'Hub name' : 'Consumer group name'
						}}<Input
							v-model="name"
							:aria-label="
								kind === 'hub' ? 'Admin hub name' : 'Admin consumer group name'
							"
							:disabled="action !== 'create' || !!eh.busy"
							:maxlength="kind === 'hub' ? 256 : 50" /></label
					><Button
						v-if="action !== 'create'"
						variant="outline"
						:disabled="!!eh.busy"
						@click="load"
						>Reload current settings</Button
					>
				</div>
				<p v-if="current?.warning" class="inspector-warning">{{ current.warning }}</p>
				<p v-if="action === 'delete'" class="inspector-warning">
					{{
						kind === 'hub'
							? 'Deleting this hub permanently removes its retained events, consumer groups and hub SAS policies. Producers and consumers will stop working.'
							: 'Deleting this consumer group interrupts clients using it. Event data is retained by the hub; external checkpoint files are not removed.'
					}}
				</p>
				<template v-else-if="writable">
					<template v-if="kind === 'hub'">
						<div class="admin-fields">
							<label
								>Partitions<Input
									v-model.number="settings.partitionCount"
									aria-label="Hub partition count"
									type="number"
									min="1"
									:max="maxPartitions"
									:disabled="
										!!eh.busy ||
										(action === 'update' &&
											!['Premium', 'Dedicated'].includes(
												admin.context?.tier ?? '',
											))
									"
							/></label>
							<label
								>Status<select
									v-model="settings.status"
									aria-label="Hub status"
									:disabled="!!eh.busy"
								>
									<option>Active</option>
									<option>Disabled</option>
									<option>SendDisabled</option>
									<option>ReceiveDisabled</option>
								</select></label
							>
							<label
								>Cleanup policy<select
									v-model="settings.cleanupPolicy"
									aria-label="Hub cleanup policy"
									:disabled="!!eh.busy || action === 'update'"
								>
									<option>Delete</option>
									<option :disabled="admin.context?.tier === 'Basic'">
										Compact
									</option>
									<option :disabled="admin.context?.tier === 'Basic'">
										DeleteOrCompact
									</option>
								</select></label
							>
							<label v-if="settings.cleanupPolicy !== 'Compact'"
								>Retention (hours)<Input
									:model-value="settings.retentionHours ?? ''"
									@update:model-value="
										settings.retentionHours =
											$event === '' ? null : Number($event)
									"
									aria-label="Hub retention hours"
									type="number"
									min="1"
									:max="maxRetention"
									:disabled="!!eh.busy"
							/></label>
							<label v-if="settings.cleanupPolicy !== 'Delete'"
								>Tombstone retention (hours; blank preserves current)<Input
									:model-value="settings.tombstoneHours ?? ''"
									@update:model-value="
										settings.tombstoneHours =
											$event === '' ? null : Number($event)
									"
									aria-label="Hub tombstone hours"
									type="number"
									min="1"
									max="2160"
									:disabled="!!eh.busy"
							/></label>
							<label v-if="settings.cleanupPolicy !== 'Delete'"
								>Minimum compaction lag (minutes; blank preserves current)<Input
									:model-value="settings.minCompactionLagMinutes ?? ''"
									@update:model-value="
										settings.minCompactionLagMinutes =
											$event === '' ? null : Number($event)
									"
									aria-label="Hub compaction lag"
									type="number"
									min="0"
									max="2147483647"
									:disabled="!!eh.busy"
							/></label>
						</div>
						<p class="explorer-note">
							Cleanup policy is fixed at creation. Only Premium/Dedicated partition
							counts can increase; increasing partitions can change key routing and
							ordering. Reducing retention can remove older events. Azure validates
							namespace quotas.
						</p>
						<label
							>User metadata<textarea
								v-model="settings.userMetadata"
								aria-label="Hub user metadata"
								maxlength="1024"
								rows="2"
								:disabled="!!eh.busy"
							/>
						</label>
						<details>
							<summary>Capture</summary>
							<label
								>Capture action<select
									v-model="captureMode"
									aria-label="Hub Capture action"
									:disabled="!!eh.busy"
								>
									<option value="preserve">
										{{
											action === 'create'
												? 'Leave Capture unconfigured'
												: 'Preserve existing Capture settings'
										}}
									</option>
									<option value="disabled">Disable Capture</option>
									<option
										value="configure"
										:disabled="admin.context?.tier === 'Basic'"
									>
										Configure / replace Capture (Avro)
									</option>
								</select></label
							>
							<template v-if="settings.capture.mode === 'configure'">
								<p class="inspector-warning">
									This replaces the Capture destination and identity. The storage
									account and container must already exist with suitable
									permissions. Capture can incur Azure charges.
								</p>
								<div class="admin-fields">
									<label
										>Interval (seconds)<Input
											v-model.number="settings.capture.intervalSeconds"
											aria-label="Capture interval seconds"
											type="number"
											min="60"
											max="900"
											:disabled="!!eh.busy" /></label
									><label
										>Size window (bytes)<Input
											v-model.number="settings.capture.sizeBytes"
											aria-label="Capture size bytes"
											type="number"
											min="10485760"
											max="524288000"
											:disabled="!!eh.busy"
									/></label>
								</div>
								<label
									>Storage account resource ID<Input
										v-model="settings.capture.storageAccountResourceId"
										aria-label="Capture storage resource ID"
										maxlength="1024"
										:disabled="!!eh.busy"
								/></label>
								<label
									>Blob container<Input
										v-model="settings.capture.blobContainer"
										aria-label="Capture blob container"
										maxlength="63"
										:disabled="!!eh.busy"
								/></label>
								<label
									>Archive name format<Input
										v-model="settings.capture.archiveNameFormat"
										aria-label="Capture archive format"
										maxlength="1024"
										:disabled="!!eh.busy"
								/></label>
								<div class="admin-fields">
									<label
										>Capture identity<select
											v-model="settings.capture.identity"
											aria-label="Capture identity"
											:disabled="!!eh.busy"
											@change="settings.capture.userAssignedIdentity = ''"
										>
											<option value="none">
												Storage access configured externally
											</option>
											<option>SystemAssigned</option>
											<option>UserAssigned</option>
										</select></label
									><label v-if="settings.capture.identity === 'UserAssigned'"
										>Managed identity resource ID<Input
											v-model="settings.capture.userAssignedIdentity"
											aria-label="Capture managed identity"
											maxlength="1024"
											:disabled="!!eh.busy"
									/></label>
								</div>
								<label class="check-row"
									><input
										v-model="settings.capture.skipEmpty"
										type="checkbox"
										:disabled="!!eh.busy"
									/>Skip empty archives</label
								>
							</template>
						</details>
					</template>
					<label v-else
						>User metadata<textarea
							v-model="metadata"
							aria-label="Consumer group user metadata"
							maxlength="1024"
							rows="4"
							:disabled="!!eh.busy"
						/>
					</label>
				</template>
				<details v-if="current?.properties.length">
					<summary>Current Azure properties</summary>
					<PropertyTable :properties="current.properties" />
				</details>
				<template v-if="action === 'delete'"
					><p class="mono">Type {{ phrase }}</p>
					<Input
						v-model="confirmation"
						aria-label="Event resource deletion confirmation"
						:disabled="!!eh.busy"
				/></template>
				<label class="check-row"
					><input
						v-model="acknowledged"
						type="checkbox"
						:disabled="admin.blocked || !writable"
					/>I reviewed this {{ action }} action for
					{{ eventAdminPath(target) || 'the new resource' }} in
					{{ eh.connection?.namespace }}.</label
				>
				<p v-if="acknowledged && !parsed.success" class="error-banner" role="alert">
					{{ parsed.error.issues[0].message }}
				</p>
				<Button
					:variant="action === 'delete' ? 'destructive' : 'default'"
					:disabled="admin.blocked || !admin.context || !writable || !parsed.success"
					@click="submit"
					>{{ action === 'create' ? 'Create' : action === 'delete' ? 'Delete' : 'Save' }}
					{{ kind === 'hub' ? 'Event Hub' : 'consumer group' }}</Button
				>
			</template>
			<Button v-else variant="outline" @click="close(false)"
				>Close administration result</Button
			>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.event-admin-dialog {
	max-width: min(1050px, calc(100vw - 3rem));
}
.admin-fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 0.8rem;
	align-items: end;
}
label {
	display: grid;
	gap: 0.3rem;
	font-size: 0.85rem;
}
.check-row {
	display: flex;
	align-items: flex-start;
	gap: 0.5rem;
}
select,
textarea {
	width: 100%;
	padding: 0.5rem;
	border: 1px solid var(--border);
	border-radius: 0.4rem;
	background: var(--background);
	color: var(--foreground);
}
summary {
	cursor: pointer;
	padding: 0.4rem 0;
}
details > label,
details > .admin-fields {
	margin: 0.6rem 0;
}
.mono {
	overflow-wrap: anywhere;
}
</style>
