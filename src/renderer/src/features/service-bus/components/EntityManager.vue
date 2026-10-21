<script setup lang="ts">
import ActionConfirmation from '../../../shared/components/ActionConfirmation.vue'
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
import {
	defaultEntitySettings,
	entityPath,
	entitySettingsSchema,
	type EntitySettings,
} from '@shared/entity-management'
import type { EntityTarget } from '@shared/service-bus'
import type { OperationOutcome } from '@shared/message-operations'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
const sb = useServiceBus()
const workspace = useWorkspace()
const mode = ref<'create' | 'update' | 'delete'>()
const kind = ref<EntityTarget['kind']>('queue')
const name = ref(''),
	topic = ref(''),
	revision = ref(''),
	confirmation = ref(''),
	validation = ref('')
const settings = ref<EntitySettings>(defaultEntitySettings('queue'))
const receipt = ref<OperationOutcome>()
const target = computed<EntityTarget>(() =>
	kind.value === 'subscription'
		? { kind: 'subscription', name: name.value, topicName: topic.value }
		: { kind: kind.value, name: name.value },
)
const title = computed(
	() =>
		`${mode.value === 'create' ? 'Create' : mode.value === 'delete' ? 'Delete' : 'Edit'} ${kind.value}`,
)
const blocked = computed(
	() =>
		mode.value !== 'create' &&
		!!sb.held.target &&
		((entityPath(target.value).toLowerCase() === entityPath(sb.held.target).toLowerCase() &&
			kind.value === sb.held.target.kind) ||
			(kind.value === 'topic' &&
				sb.held.target.kind === 'subscription' &&
				sb.held.target.topicName.toLowerCase() === name.value.toLowerCase())),
)
const states = computed(() => [
	'Active',
	'Disabled',
	...(kind.value !== 'subscription' ? ['SendDisabled'] : []),
	...(kind.value !== 'topic' ? ['ReceiveDisabled'] : []),
])
type Field = {
	key: keyof EntitySettings
	label: string
	hint: string
	type?: 'number' | 'boolean'
	immutable?: boolean
	kinds?: EntityTarget['kind'][]
}
const fields: Field[] = [
	{
		key: 'defaultMessageTimeToLive',
		label: 'Default message TTL',
		hint: 'Duration or unlimited; messages may choose a shorter TTL.',
	},
	{
		key: 'autoDeleteOnIdle',
		label: 'Auto-delete on idle',
		hint: 'disabled, or a duration of at least 00:05:00. Enabling this can delete the entity.',
	},
	{
		key: 'lockDuration',
		label: 'Lock duration',
		hint: 'Positive duration, at most 00:05:00.',
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'maxDeliveryCount',
		label: 'Maximum delivery count',
		hint: 'Messages exceeding this limit move to the dead-letter queue.',
		type: 'number',
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'maxSizeInMegabytes',
		label: 'Maximum entity size (MiB)',
		hint: 'For example 1024. Supported sizes depend on the namespace tier.',
		type: 'number',
		kinds: ['queue', 'topic'],
	},
	{
		key: 'maxMessageSizeInKilobytes',
		label: 'Maximum message size (KiB)',
		hint: 'Premium only. Blank leaves the SDK/service default.',
		type: 'number',
		kinds: ['queue', 'topic'],
	},
	{
		key: 'duplicateDetectionHistoryTimeWindow',
		label: 'Duplicate detection window',
		hint: '00:00:20–7.00:00:00; applies when duplicate detection is enabled.',
		kinds: ['queue', 'topic'],
	},
	{
		key: 'forwardTo',
		label: 'Forward to',
		hint: 'Existing queue/topic in this namespace, or blank to disable. Forwarding prevents manual receives here.',
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'forwardDeadLetteredMessagesTo',
		label: 'Forward dead letters to',
		hint: 'Existing queue/topic in this namespace, or blank to disable.',
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'requiresSession',
		label: 'Require sessions',
		hint: 'Creation only. Consumers must accept a session.',
		type: 'boolean',
		immutable: true,
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'requiresDuplicateDetection',
		label: 'Require duplicate detection',
		hint: 'Creation only. Duplicate message IDs can be discarded.',
		type: 'boolean',
		immutable: true,
		kinds: ['queue', 'topic'],
	},
	{
		key: 'enablePartitioning',
		label: 'Enable partitioning',
		hint: 'Creation only where supported; Premium partitioning is configured at namespace level.',
		type: 'boolean',
		immutable: true,
		kinds: ['queue', 'topic'],
	},
	{
		key: 'deadLetteringOnMessageExpiration',
		label: 'Dead-letter expired messages',
		hint: 'Retain expired messages in the dead-letter subqueue.',
		type: 'boolean',
		kinds: ['queue', 'subscription'],
	},
	{
		key: 'enableDeadLetteringOnFilterEvaluationExceptions',
		label: 'Dead-letter filter evaluation failures',
		hint: 'Retain messages whose subscription rule evaluation fails.',
		type: 'boolean',
		kinds: ['subscription'],
	},
	{
		key: 'enableBatchedOperations',
		label: 'Enable broker batched operations',
		hint: 'Controls broker-side batching.',
		type: 'boolean',
	},
	{
		key: 'supportOrdering',
		label: 'Support ordering',
		hint: 'Forward to subscriptions in order; has no effect on partitioned topics.',
		type: 'boolean',
		kinds: ['topic'],
	},
]
const visibleFields = computed(() =>
	fields.filter((field) => !field.kinds || field.kinds.includes(kind.value)),
)
function assign(key: keyof EntitySettings, value: string | number | boolean | null) {
	;(settings.value as unknown as Record<string, unknown>)[key] = value
}
function editNumber(key: keyof EntitySettings, value: string | number) {
	assign(key, value === '' ? null : Number(value))
}
function close(open = false) {
	if (!open && !sb.busy) mode.value = undefined
}
function create(value: EntityTarget['kind'], parentTopic?: string) {
	if (sb.busy || !sb.connection) return
	kind.value = value
	name.value = ''
	topic.value =
		parentTopic ??
		(sb.selected?.target.kind === 'topic' ? sb.selected.target.name : (sb.topicName ?? ''))
	settings.value = defaultEntitySettings(value)
	revision.value = ''
	confirmation.value = ''
	receipt.value = undefined
	validation.value = ''
	mode.value = 'create'
}
async function existing(value: 'update' | 'delete', entityTarget = sb.selected?.target) {
	if (!entityTarget || sb.busy || !sb.connection) return
	const connectionId = sb.connection.connectionId
	const selected = { ...entityTarget }
	const config = await sb.getConfiguration(selected)
	if (!config || sb.connection?.connectionId !== connectionId) return
	kind.value = selected.kind
	name.value = selected.name
	topic.value = selected.kind === 'subscription' ? selected.topicName : ''
	settings.value = config.settings
	revision.value = config.revision
	confirmation.value = ''
	receipt.value = undefined
	validation.value = ''
	mode.value = value
}
async function reload() {
	const config = await sb.getConfiguration(target.value)
	if (config) {
		settings.value = config.settings
		revision.value = config.revision
		confirmation.value = ''
		receipt.value = undefined
		validation.value = ''
	}
}
async function submit() {
	if (!mode.value || sb.busy || blocked.value || receipt.value?.status === 'unknown') return
	validation.value = ''
	if (mode.value !== 'delete') {
		const parsed = entitySettingsSchema.safeParse(settings.value)
		if (!parsed.success) {
			validation.value = parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join(' ')
			return
		}
	}
	receipt.value = await sb.manageEntity(
		mode.value,
		target.value,
		settings.value,
		revision.value,
		confirmation.value,
	)
	if (receipt.value?.status === 'confirmed') mode.value = undefined
}
async function check() {
	await sb.checkOutcome()
	receipt.value = sb.outcome
	if (receipt.value?.status === 'confirmed') {
		await sb.browse(kind.value, kind.value === 'subscription' ? topic.value : undefined)
		if (mode.value !== 'delete')
			await sb.select({
				target: target.value,
				status: settings.value.status,
				requiresSession: settings.value.requiresSession,
			})
		mode.value = undefined
	}
}
function cancelOperation() {
	const job = workspace.jobs.find((job) => job.status === 'running' && job.label === sb.busy)
	if (job) void workspace.cancel(job.id)
}
defineExpose({ create, existing })
watch(
	() => sb.connection?.connectionId,
	() => {
		mode.value = undefined
		receipt.value = undefined
	},
)
</script>
<template>
	<div class="explorer-actions entity-management" aria-label="Entity management">
		<Button :disabled="!!sb.busy" @click="create(sb.category)">Create {{ sb.category }}</Button>
		<Button
			v-if="sb.selected?.target.kind === 'topic'"
			variant="outline"
			:disabled="!!sb.busy"
			@click="create('subscription')"
			>Create subscription</Button
		>
		<Button
			v-if="sb.selected"
			variant="outline"
			:disabled="!!sb.busy"
			@click="existing('update')"
			>Edit {{ sb.selected.target.kind }}</Button
		>
		<Button
			v-if="sb.selected"
			variant="outline"
			:disabled="!!sb.busy"
			@click="existing('delete')"
			>Delete {{ sb.selected.target.kind }}</Button
		>
	</div>
	<Dialog :open="!!mode" @update:open="close">
		<DialogContent
			class="message-dialog entity-dialog"
			@escape-key-down="sb.busy && $event.preventDefault()"
			@interact-outside="sb.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription>{{
					mode === 'delete'
						? 'Permanently remove this entity and its stored messages.'
						: 'Review the destination and entity settings before saving.'
				}}</DialogDescription></DialogHeader
			>
			<form class="composer-form" @submit.prevent="submit">
				<div class="write-destination">
					<strong>{{ sb.connection?.namespace }}</strong
					><span>{{ kind }} / {{ entityPath(target) || '(new entity)' }}</span>
				</div>
				<fieldset :disabled="!!sb.busy || receipt?.status === 'unknown'">
					<template v-if="mode !== 'delete'">
						<div class="composer-grid">
							<label v-if="kind === 'subscription'"
								>Parent topic<Input
									v-model="topic"
									aria-label="Parent topic"
									readonly
							/></label>
							<label
								>Entity name<Input
									v-model="name"
									aria-label="Entity name"
									:readonly="mode !== 'create'"
									:maxlength="kind === 'subscription' ? 50 : 260"
									required
							/></label>
							<label
								>Status<select
									v-model="settings.status"
									class="commander-select"
									aria-label="Entity status"
								>
									<option v-for="value in states" :key="value">
										{{ value }}
									</option>
								</select></label
							>
						</div>
						<p class="explorer-note">
							Durations use [days.]hh:mm:ss[.fffffff]. Namespace tier restrictions are
							checked by Azure.
						</p>
						<p
							v-if="kind === 'subscription' && mode === 'create'"
							class="inspector-warning"
						>
							The new subscription starts with a match-all $Default rule and receives
							all messages published to this topic. Use Manage subscription rules
							after creation to edit or remove it.
						</p>
						<p v-if="mode === 'update'" class="explorer-note">
							Names, sessions, partitioning and duplicate detection cannot be changed
							here. Authorization rules and subscription filters are preserved.
						</p>
						<div class="composer-grid entity-settings">
							<label
								v-for="field in visibleFields"
								:key="field.key"
								:class="{ 'entity-checkbox': field.type === 'boolean' }"
							>
								<span
									v-if="field.type === 'boolean'"
									class="entity-checkbox-control"
									><input
										type="checkbox"
										:aria-label="field.label"
										:checked="!!settings[field.key]"
										:disabled="!!field.immutable && mode !== 'create'"
										@change="
											assign(
												field.key,
												($event.target as HTMLInputElement).checked,
											)
										"
									/>{{ field.label }}</span
								>
								<template v-else
									>{{ field.label
									}}<Input
										v-if="field.type === 'number'"
										:model-value="
											(settings[field.key] as number | undefined) ?? ''
										"
										:aria-label="field.label"
										type="number"
										min="1"
										@update:model-value="editNumber(field.key, $event)" /><Input
										v-else
										:model-value="settings[field.key] as string"
										:aria-label="field.label"
										:maxlength="field.key.startsWith('forward') ? 260 : 40"
										@update:model-value="assign(field.key, $event)"
								/></template>
								<small class="explorer-note">{{ field.hint }}</small>
							</label>
						</div>
						<label
							>User metadata<textarea
								v-model="settings.userMetadata"
								class="commander-textarea"
								aria-label="User metadata"
								rows="2"
								maxlength="1024"
							></textarea
							><small class="explorer-note">Maximum 1024 UTF-8 bytes.</small></label
						>
						<p
							v-if="settings.autoDeleteOnIdle !== 'disabled'"
							class="inspector-warning"
						>
							Auto-delete is enabled. Azure can delete this entity after the
							configured idle interval.
						</p>
						<p
							v-if="settings.forwardTo || settings.forwardDeadLetteredMessagesTo"
							class="inspector-warning"
						>
							Forwarding moves messages to the specified entity in this namespace.
							Verify the destination exists and the route does not form a loop.
						</p>
					</template>
					<template v-else>
						<p class="inspector-warning">
							{{
								kind === 'topic'
									? 'Deleting this topic also deletes every subscription, its rules and all stored messages, including dead-letter messages.'
									: 'All active, scheduled, deferred and dead-letter messages stored in this entity will be lost.'
							}}
							This cannot be undone.
						</p>
						<p class="explorer-note">
							Message counts are a changing snapshot and are not used to decide
							whether deletion is safe.
						</p>
						<label v-if="kind !== 'queue'"
							>Type {{ entityPath(target) }} to confirm<Input
								v-model="confirmation"
								aria-label="Confirm entity path"
								maxlength="550"
								autocomplete="off"
						/></label>
						<ActionConfirmation
							v-else
							v-model="confirmation"
							:expected="entityPath(target)"
							label="I understand this queue and all its messages will be permanently deleted."
						/>
					</template>
				</fieldset>
				<p v-if="blocked" class="inspector-warning">
					Close this entity's receiver before editing or deleting it. Settle owned
					messages first; closing an unsettled receiver leaves locks to expire.
				</p>
				<p v-if="validation || sb.error" class="error-banner" role="alert">
					{{ validation || sb.error }}
				</p>
				<p v-if="receipt" class="inspector-warning" role="status">
					{{ receipt.status }}: {{ receipt.summary
					}}<Button
						v-if="receipt.status === 'unknown'"
						type="button"
						variant="outline"
						:disabled="!!sb.busy"
						@click="check"
						>Check outcome</Button
					>
				</p>
				<div class="explorer-actions entity-form-actions">
					<Button
						type="submit"
						:variant="mode === 'delete' ? 'destructive' : 'default'"
						:disabled="
							!!sb.busy ||
							blocked ||
							receipt?.status === 'unknown' ||
							!name.trim() ||
							(mode === 'delete' && confirmation !== entityPath(target))
						"
						>{{
							mode === 'create'
								? 'Create ' + kind
								: mode === 'delete'
									? 'Permanently delete ' + kind
									: 'Save changes'
						}}</Button
					>
					<Button
						v-if="mode !== 'create' && receipt?.status !== 'unknown'"
						type="button"
						variant="outline"
						:disabled="!!sb.busy"
						@click="reload"
						>Reload settings (discard draft)</Button
					>
					<Button type="button" variant="outline" :disabled="!!sb.busy" @click="close()"
						>Cancel</Button
					>
					<Button v-if="sb.busy" type="button" variant="outline" @click="cancelOperation"
						>Cancel operation</Button
					>
				</div>
			</form>
		</DialogContent>
	</Dialog>
</template>
