<script setup lang="ts">
import { eventGridApi } from '@/features/event-grid/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import JsonBody from '../../../shared/components/JsonBody.vue'
import EventGridDeliveryEditor from './EventGridDeliveryEditor.vue'
import type { EventGridDelivery } from '@shared/contracts/event-grid/delivery'
import { useEventGrid } from '@/features/event-grid/stores/event-grid'
import { useWorkspace } from '@/shared/workspace/store'
import { eventGridPath, type EventGridTarget } from '@shared/contracts/event-grid/core'
import {
	eventGridAdminChangeSchema,
	eventGridOperators,
	type EventGridAdminDetails,
	type EventGridAdminFilter,
	type EventGridSubscriptionSettings,
	type EventGridDestination,
} from '@shared/contracts/event-grid/administration'
const props = defineProps<{ target: EventGridTarget; action: 'create' | 'update' | 'delete' }>(),
	emit = defineEmits<{ close: [] }>(),
	grid = useEventGrid(),
	workspace = useWorkspace()
const current = ref<EventGridAdminDetails>(),
	name = ref(props.target.subscriptionName ?? props.target.topicName ?? ''),
	retention = ref(7),
	settings = ref<EventGridSubscriptionSettings>({
		deliveryMode: 'Queue',
		receiveLockDurationInSeconds: 60,
		maxDeliveryCount: 10,
		eventTimeToLive: 'P1D',
		expirationTimeUtc: null,
		includedEventTypes: null,
		filters: [],
	}),
	allTypes = ref(true),
	typesText = ref(''),
	expiration = ref(''),
	replaceDestination = ref(false),
	delivery = ref<EventGridDelivery>({ identity: null, headers: null, deadLetter: null }),
	endpointType = ref<EventGridDestination['endpointType']>('WebHook'),
	endpoint = ref(''),
	queueName = ref(''),
	acknowledged = ref(false),
	confirmation = ref(''),
	done = ref(false),
	error = ref('')
const title = computed(
	() =>
		`${props.action === 'create' ? 'Create' : props.action === 'update' ? 'Edit' : 'Delete'} Event Grid ${props.target.kind}`,
)
const job = computed(() => workspace.jobs.find((j) => j.id === grid.operationId))
watch(
	() => [props.target, props.action],
	async () => {
		if (props.action !== 'create') {
			current.value = await grid.adminGet(props.target)
			if (current.value?.settings) {
				settings.value = JSON.parse(JSON.stringify(current.value.settings))
				allTypes.value = settings.value.includedEventTypes === null
				typesText.value = settings.value.includedEventTypes?.join('\n') ?? ''
				expiration.value = settings.value.expirationTimeUtc ?? ''
			}
			retention.value = current.value?.retentionDays ?? 7
		}
	},
	{ immediate: true },
)
watch(
	[
		name,
		retention,
		settings,
		allTypes,
		typesText,
		expiration,
		replaceDestination,
		delivery,
		endpointType,
		endpoint,
		queueName,
		confirmation,
	],
	() => {
		acknowledged.value = false
		error.value = ''
	},
	{ deep: true },
)
watch([replaceDestination, endpointType], () => {
	endpoint.value = ''
	queueName.value = ''
})
function addFilter() {
	settings.value.filters?.push({
		key: 'data.category',
		operatorType: 'StringIn',
		operandJson: '["value"]',
	})
}
function changeOperator(filter: EventGridAdminFilter) {
	filter.operandJson =
		filter.operatorType === 'BoolEquals'
			? 'true'
			: filter.operatorType.startsWith('Is')
				? ''
				: filter.operatorType.endsWith('Range')
					? '[[0,100]]'
					: filter.operatorType.includes('GreaterThan') ||
						  filter.operatorType.includes('LessThan')
						? '0'
						: filter.operatorType.startsWith('Number')
							? '[0]'
							: '["value"]'
}
const target = computed<EventGridTarget>(() =>
	props.action !== 'create'
		? { ...props.target }
		: props.target.kind === 'topic'
			? { kind: 'topic', topicName: name.value.trim(), subscriptionName: null }
			: {
					kind: 'subscription',
					topicName: props.target.topicName ?? '',
					subscriptionName: name.value.trim(),
				},
)
const filterPreview = computed(
	() =>
		'[\n' +
		(settings.value.filters ?? [])
			.map(
				(f) =>
					`{ "key": ${JSON.stringify(f.key)}, "operatorType": ${JSON.stringify(f.operatorType)}${f.operatorType.startsWith('Is') ? '' : `, "${f.operatorType === 'BoolEquals' || f.operatorType.includes('GreaterThan') || f.operatorType.includes('LessThan') ? 'value' : 'values'}": ${f.operandJson}`} }`,
			)
			.join(',\n') +
		'\n]',
)
async function submit() {
	if (done.value || grid.writeBlocked || (props.action !== 'create' && !current.value)) return
	const sub = props.action !== 'delete' && target.value.kind === 'subscription'
	let destination: EventGridDestination | null = null
	if (
		sub &&
		(props.action === 'create' || replaceDestination.value) &&
		settings.value.deliveryMode === 'Push'
	)
		destination =
			endpointType.value === 'WebHook'
				? {
						endpointType: 'WebHook',
						endpointUrl: endpoint.value.trim(),
						resourceId: null,
						queueName: null,
					}
				: {
						endpointType: endpointType.value,
						endpointUrl: null,
						resourceId: endpoint.value.trim(),
						queueName:
							endpointType.value === 'StorageQueue' ? queueName.value.trim() : null,
					}
	const parsed = eventGridAdminChangeSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: grid.connection?.connectionId,
		target: target.value,
		action: props.action,
		expectedRevision: props.action === 'create' ? null : current.value?.revision,
		retentionDays:
			props.action !== 'delete' && target.value.kind === 'topic' ? retention.value : null,
		settings: sub
			? {
					...settings.value,
					receiveLockDurationInSeconds:
						settings.value.deliveryMode === 'Queue'
							? settings.value.receiveLockDurationInSeconds
							: null,
					includedEventTypes: allTypes.value
						? null
						: typesText.value
								.split('\n')
								.map((t) => t.trim())
								.filter(Boolean),
					expirationTimeUtc: expiration.value.trim() || null,
				}
			: null,
		destination,
		delivery: sub ? delivery.value : null,
		acknowledged: acknowledged.value,
		confirmation: props.action === 'delete' ? confirmation.value : null,
	})
	if (!parsed.success) {
		error.value = parsed.error.issues[0]?.message ?? 'Review the settings and acknowledgement.'
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = parsed.data
	const result = await grid.change(setup)
	if (result) {
		delivery.value = { identity: null, headers: null, deadLetter: null }
		endpoint.value = '' // Never retain a write-only URL after a receipt.
		done.value = true
		await grid.afterChange(result)
	}
}
async function signIn() {
	const result = await eventGridApi.openDeviceLogin()
	if (!result.ok) error.value = result.error.message
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !grid.busy && emit('close')"
		><DialogContent class="sm:max-w-[900px] eg-inspector eg-editor" :show-close-button="false"
			><DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription
					>{{ grid.connection?.namespace }} ·
					{{ eventGridPath(target) }}</DialogDescription
				></DialogHeader
			>
			<form id="eg-admin-form" class="eg-inspector-scroll" @submit.prevent="submit">
				<template v-if="!done && (action === 'create' || current)">
					<label v-if="action === 'create'"
						>Resource name<Input
							v-model="name"
							:disabled="grid.blocked"
							placeholder="3–50 letters, digits or hyphens"
					/></label>
					<template v-if="action === 'delete'"
						><p class="form-warning">
							This permanently deletes
							{{
								target.kind === 'topic'
									? 'the topic, its subscriptions and retained events'
									: 'the subscription and its retained events'
							}}. This cannot be undone.
						</p>
						<label
							>Type the exact name to delete<Input
								v-model="confirmation"
								:disabled="grid.blocked" /></label
					></template>
					<template v-else-if="target.kind === 'topic'"
						><label
							>Topic retention (days)<Input
								v-model.number="retention"
								type="number"
								min="1"
								max="7"
								:disabled="grid.blocked"
						/></label>
						<p class="field-hint">
							Custom publisher · CloudEvents 1.0 · 1–7 days. Azure validates retention
							against existing subscriptions.
						</p></template
					>
					<template v-else-if="action === 'create' || current?.settings">
						<div class="nh-fields">
							<label
								>Delivery mode<select
									v-model="settings.deliveryMode"
									aria-label="Delivery mode"
									:disabled="grid.blocked || action !== 'create'"
								>
									<option>Queue</option>
									<option>Push</option>
								</select></label
							><label
								>Maximum delivery count<Input
									:model-value="settings.maxDeliveryCount ?? ''"
									@update:model-value="
										settings.maxDeliveryCount =
											$event === '' ? null : Number($event)
									"
									type="number"
									min="1"
									max="10"
									:disabled="grid.blocked"
							/></label>
						</div>
						<div class="nh-fields">
							<label v-if="settings.deliveryMode === 'Queue'"
								>Receive lock (seconds)<Input
									:model-value="settings.receiveLockDurationInSeconds ?? ''"
									@update:model-value="
										settings.receiveLockDurationInSeconds =
											$event === '' ? null : Number($event)
									"
									type="number"
									min="60"
									max="300"
									:disabled="grid.blocked" /></label
							><label
								>Event TTL (ISO 8601)<Input
									:model-value="settings.eventTimeToLive ?? ''"
									@update:model-value="
										settings.eventTimeToLive = String($event).trim() || null
									"
									placeholder="P1D"
									:disabled="grid.blocked"
							/></label>
						</div>
						<p class="field-hint">
							TTL is at least PT1M and cannot exceed topic retention. Empty delivery
							fields preserve Azure settings/defaults.
						</p>
						<label
							v-if="action === 'update' && settings.deliveryMode === 'Push'"
							class="eg-check"
							><input
								v-model="replaceDestination"
								type="checkbox"
								:disabled="grid.blocked"
							/>
							Replace delivery destination</label
						>
						<p v-if="replaceDestination" class="form-warning">
							The new destination replaces the old endpoint, authentication and
							headers. Review the identity and enter fresh headers below. Dead-letter
							settings are kept unless changed.
						</p>
						<template
							v-if="
								(action === 'create' || replaceDestination) &&
								settings.deliveryMode === 'Push'
							"
							><label
								>Push destination type<select
									v-model="endpointType"
									aria-label="Push destination type"
									:disabled="grid.blocked"
								>
									<option
										v-for="type in [
											'WebHook',
											'EventHub',
											'ServiceBusQueue',
											'ServiceBusTopic',
											'NamespaceTopic',
											'AzureFunction',
											'HybridConnection',
											'StorageQueue',
										]"
										:key="type"
									>
										{{ type }}
									</option>
								</select></label
							><label
								>{{
									endpointType === 'WebHook'
										? 'HTTPS webhook URL (write-only)'
										: 'Destination ARM resource ID'
								}}<Input
									v-model="endpoint"
									:type="endpointType === 'WebHook' ? 'password' : 'text'"
									autocomplete="off"
									:disabled="grid.blocked" /></label
							><label v-if="endpointType === 'StorageQueue'"
								>Storage queue name<Input
									v-model="queueName"
									:disabled="grid.blocked" /></label
						></template>
						<p
							v-if="
								settings.deliveryMode === 'Push' &&
								(action === 'create' || replaceDestination)
							"
							class="field-hint"
						>
							Namespace push handlers currently documented by Azure are Event Hubs and
							Webhooks. Other destination types in the ARM model depend on Azure
							service availability.
						</p>
						<EventGridDeliveryEditor
							v-model="delivery"
							:destination-type="
								action === 'create' || replaceDestination
									? endpointType
									: current?.delivery?.destinationType
							"
							:mode="settings.deliveryMode"
							:creating="action === 'create'"
							:disabled="grid.blocked"
							:current="current?.delivery"
							:replacing="replaceDestination"
						/>
						<label
							>Expiration UTC (optional)<Input
								v-model="expiration"
								placeholder="2030-01-01T00:00:00Z"
								:disabled="grid.blocked"
						/></label>
						<label class="eg-check"
							><input v-model="allTypes" type="checkbox" :disabled="grid.blocked" />
							All default event types</label
						>
						<label v-if="!allTypes"
							>Included event types (one per line)<textarea
								v-model="typesText"
								rows="3"
								:disabled="grid.blocked"
							/>
						</label>
						<p class="field-hint">
							Uncheck all defaults and leave the list empty to send an explicit empty
							list. Filters are combined using Azure's filtering rules.
						</p>
						<h3>Advanced filters</h3>
						<p class="field-hint">
							Up to 25 filters and 25 values in total; strings up to 512 characters.
							Numeric JSON text is preserved as entered.
						</p>
						<p v-if="settings.filters === null" class="form-warning">
							Unsupported filters are preserved unchanged. Event types and delivery
							settings can still be edited.
						</p>
						<div
							v-for="(filter, index) in settings.filters"
							:key="index"
							class="eg-filter-edit"
						>
							<div class="nh-fields">
								<label
									>Filter key<Input
										v-model="filter.key"
										:aria-label="`Filter ${index + 1} key`"
										:disabled="grid.blocked" /></label
								><label
									>Operator<select
										v-model="filter.operatorType"
										:aria-label="`Filter ${index + 1} operator`"
										:disabled="grid.blocked"
										@change="changeOperator(filter)"
									>
										<option v-for="op in eventGridOperators" :key="op">
											{{ op }}
										</option>
									</select></label
								>
							</div>
							<label v-if="!filter.operatorType.startsWith('Is')"
								>{{
									filter.operatorType.endsWith('Range')
										? 'JSON ranges, e.g. [[0,100],[200,300]]'
										: filter.operatorType === 'BoolEquals'
											? 'JSON boolean: true or false'
											: filter.operatorType.includes('GreaterThan') ||
												  filter.operatorType.includes('LessThan')
												? 'JSON number'
												: 'JSON array of values'
								}}<textarea
									v-model="filter.operandJson"
									:aria-label="`Filter ${index + 1} values`"
									rows="2"
									:disabled="grid.blocked"
									spellcheck="false"
								/></label
							><Button
								type="button"
								variant="ghost"
								:disabled="grid.blocked"
								@click="settings.filters?.splice(index, 1)"
								>Remove filter {{ index + 1 }}</Button
							>
						</div>
						<Button
							v-if="settings.filters !== null"
							type="button"
							variant="outline"
							:disabled="grid.blocked || settings.filters.length >= 25"
							@click="addFilter"
							>Add advanced filter</Button
						>
						<details v-if="settings.filters !== null">
							<summary>Review filter JSON</summary>
							<JsonBody :text="filterPreview" />
						</details>
					</template>
					<p v-else class="form-warning">
						These settings cannot be edited. You can inspect or delete this resource.
					</p>
					<p v-if="current?.warning" class="form-warning">{{ current.warning }}</p>
					<label class="eg-check"
						><input v-model="acknowledged" type="checkbox" :disabled="grid.blocked" /> I
						reviewed this {{ action }} action and its Azure target.</label
					>
				</template>
				<p
					v-if="done && grid.outcome"
					role="status"
					:class="grid.outcome.status === 'confirmed' ? 'field-hint' : 'form-warning'"
				>
					{{ grid.outcome.summary }}<br />Receipt: {{ grid.outcome.operationId }}
				</p>
				<p v-if="grid.busy" role="status">
					{{ grid.busy }}… Cancellation after dispatch cannot undo an Azure change.
				</p>
				<div v-if="job?.code">
					<p>Sign in to continue.</p>
					<p class="device-code">{{ job.code }}</p>
					<Button type="button" variant="outline" @click="signIn"
						>Open Microsoft sign-in</Button
					>
				</div>
				<p v-if="error || grid.error" role="alert" class="form-error">
					{{ error || grid.error }}
				</p>
			</form>
			<DialogFooter
				><Button v-if="grid.busy" variant="outline" @click="grid.cancel()"
					>Cancel Event Grid operation</Button
				><Button
					v-if="!done"
					type="submit"
					form="eg-admin-form"
					:disabled="
						grid.writeBlocked ||
						!acknowledged ||
						(action !== 'create' && !current) ||
						(action === 'update' &&
							target.kind === 'subscription' &&
							!current?.settings)
					"
					:variant="action === 'delete' ? 'destructive' : 'default'"
					>{{ title }}</Button
				><Button variant="outline" :disabled="grid.blocked" @click="emit('close')"
					>Close editor</Button
				></DialogFooter
			>
		</DialogContent></Dialog
	>
</template>
<style>
.eg-editor label {
	display: flex;
	flex-direction: column;
	gap: 6px;
	font-size: 12px;
}
.eg-editor select,
.eg-editor textarea {
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	padding: 8px;
	color: var(--foreground);
	min-width: 0;
	width: 100%;
}
.eg-editor textarea {
	font-family: var(--font-mono);
	resize: vertical;
}
.eg-editor .eg-check {
	flex-direction: row;
	align-items: center;
	gap: 8px;
}
.eg-filter-edit {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}
</style>
