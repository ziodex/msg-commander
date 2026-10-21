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
	DialogFooter,
} from '@/shared/ui/dialog'
import {
	defaultNotificationHubSettings,
	nhChangeSchema,
	nhPath,
	type NotificationHubTarget,
	type NotificationHubChange,
	type NotificationHubDetails,
} from '@shared/contracts/notification-hubs/core'
import type { AuthorizationRight } from '@shared/authorization'
import { useNotificationHubs } from '@/features/notification-hubs/stores/notification-hubs'
const props = defineProps<{
	target: NotificationHubTarget
	action: NotificationHubChange['action']
}>()
const emit = defineEmits<{ close: [] }>()
const nh = useNotificationHubs(),
	name = ref(''),
	current = ref<NotificationHubDetails>(),
	error = ref(''),
	ack = ref(false),
	done = ref(false)
const settings = ref(defaultNotificationHubSettings()),
	rights = ref<AuthorizationRight[]>(['Listen']),
	keyType = ref<'PrimaryKey' | 'SecondaryKey'>('PrimaryKey')
const policy = computed(() => props.target.policyName !== null)
const target = computed<NotificationHubTarget>(() => ({
	scope: {
		...props.target.scope,
		name: props.action === 'create' && !policy.value ? name.value : props.target.scope.name,
	} as NotificationHubTarget['scope'],
	policyName: props.action === 'create' && policy.value ? name.value : props.target.policyName,
}))
const title = computed(
	() =>
		`${props.action === 'create' ? 'Create' : props.action === 'update' ? 'Edit' : props.action === 'delete' ? 'Delete' : 'Regenerate key for'} ${policy.value ? 'SAS policy' : 'Notification Hub'}`,
)
const editing = computed(() => props.action === 'create' || props.action === 'update')
const unsupported = computed(
	() => props.action === 'update' && !policy.value && !current.value?.settings,
)
watch(
	() => [props.target, props.action],
	async () => {
		ack.value = false
		done.value = false
		current.value = undefined
		error.value = ''
		name.value = ''
		settings.value = defaultNotificationHubSettings()
		rights.value = ['Listen']
		keyType.value = 'PrimaryKey'
		if (props.action !== 'create') {
			const value = await nh.get(props.target)
			if (value) {
				current.value = value
				if (value.settings)
					settings.value = {
						...value.settings,
						tags: value.settings.tags.map((t) => ({ ...t })),
					}
				if (value.rights) rights.value = [...value.rights]
			}
		}
	},
	{ immediate: true },
)
watch(
	[settings, rights, name, keyType],
	() => {
		ack.value = false
	},
	{ deep: true },
)
function setRight(right: AuthorizationRight, checked: boolean) {
	const next = new Set(rights.value)
	if (checked) next.add(right)
	else next.delete(right)
	if (right === 'Manage' && checked) {
		next.add('Send')
		next.add('Listen')
	}
	if (right !== 'Manage' && !checked) next.delete('Manage')
	rights.value = [...next]
}
async function submit() {
	if (
		!ack.value ||
		nh.blocked ||
		(props.action !== 'create' && !current.value) ||
		unsupported.value
	)
		return
	const parsed = nhChangeSchema.safeParse({
		id: crypto.randomUUID(),
		connectionId: nh.connection?.connectionId,
		target: target.value,
		action: props.action,
		expectedRevision: current.value?.revision ?? null,
		settings: editing.value && !policy.value ? settings.value : null,
		rights: editing.value && policy.value ? rights.value : null,
		keyType: props.action === 'regenerate' ? keyType.value : null,
		acknowledged: true,
	})
	if (!parsed.success) {
		error.value = parsed.error.issues[0].message
		return
	}
	const { id: _id, connectionId: _connection, ...setup } = parsed.data
	const result = await nh.change(setup)
	if (result) {
		done.value = true
		ack.value = false
		await nh.afterChange(result)
	}
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !nh.busy && emit('close')"
		><DialogContent
			class="sm:max-w-[620px] nh-dialog"
			@escape-key-down="nh.busy && $event.preventDefault()"
			@interact-outside="$event.preventDefault()"
			><DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription
					>{{ nh.connection?.namespace }} · {{ nhPath(target) }}</DialogDescription
				></DialogHeader
			>
			<template v-if="done"
				><p role="status">{{ nh.outcome?.summary }}</p>
				<p class="field-hint">Receipt: {{ nh.outcome?.operationId }}</p>
				<Button variant="outline" :disabled="!!nh.busy" @click="emit('close')"
					>Close Notification Hubs result</Button
				></template
			>
			<form v-else class="nh-form" @submit.prevent="submit">
				<fieldset :disabled="!!nh.busy">
					<label v-if="action === 'create'"
						>{{ policy ? 'Policy name' : 'Hub name'
						}}<Input v-model="name" :maxlength="policy ? 256 : 265" required
					/></label>
					<template v-if="editing && !policy">
						<label
							>Registration lifetime<Input
								v-model="settings.registrationTtl"
								required
								placeholder="90.00:00:00"
						/></label>
						<p class="field-hint">
							Days.hh:mm:ss. The default maximum keeps registrations from expiring.
							Existing push-provider credentials are preserved when editing.
						</p>
						<div class="nh-heading">
							<strong>Azure tags</strong
							><Button
								type="button"
								size="sm"
								variant="outline"
								:disabled="settings.tags.length >= 50"
								@click="settings.tags.push({ name: '', value: '' })"
								>Add tag</Button
							>
						</div>
						<div v-for="(tag, index) in settings.tags" :key="index" class="nh-tag-row">
							<label>Tag name<Input v-model="tag.name" maxlength="512" /></label>
							<label>Tag value<Input v-model="tag.value" maxlength="256" /></label>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								:aria-label="`Remove tag ${index + 1}`"
								@click="settings.tags.splice(index, 1)"
								>Remove</Button
							>
						</div>
					</template>
					<fieldset v-if="editing && policy">
						<legend>Policy rights</legend>
						<label
							v-for="right in ['Listen', 'Send', 'Manage'] as const"
							:key="right"
							class="checkbox-label"
							><input
								type="checkbox"
								:checked="rights.includes(right)"
								@change="
									setRight(right, ($event.target as HTMLInputElement).checked)
								"
							/>{{ right }}</label
						>
						<p class="field-hint">Manage includes Send and Listen.</p>
					</fieldset>
					<template v-if="action === 'regenerate'"
						><label
							>Key slot<select aria-label="Key slot" v-model="keyType">
								<option value="PrimaryKey">Primary key</option>
								<option value="SecondaryKey">Secondary key</option>
							</select></label
						>
						<p class="form-warning">
							Clients using this key will lose access. Switch them to the other key
							before rotation.
						</p></template
					>
					<p v-if="action === 'delete'" class="form-warning">
						Permanently delete {{ nhPath(target)
						}}{{
							policy ? '' : ' and its registrations, installations and SAS policies'
						}}. Connected clients may lose access.
					</p>
					<p v-if="current?.warning" class="form-warning">{{ current.warning }}</p>
					<p v-if="action !== 'create'" class="field-hint">
						The current settings are checked again before saving. This is a preflight
						check, not an atomic conditional write. Coordinate concurrent
						administration.
					</p>
					<label class="checkbox-label"
						><input
							v-model="ack"
							type="checkbox"
							:disabled="unsupported || (action !== 'create' && !current)"
						/>I reviewed this {{ action }} action for {{ nhPath(target) }}.</label
					>
				</fieldset>
				<p v-if="error || nh.error" class="form-error" role="alert">
					{{ error || nh.error }}
				</p>
				<p v-if="nh.busy" role="status">{{ nh.busy }}…</p>
				<DialogFooter
					><Button v-if="nh.busy" type="button" variant="outline" @click="nh.cancel()"
						>Cancel operation</Button
					><Button v-else type="button" variant="outline" @click="emit('close')"
						>Cancel</Button
					><Button
						type="submit"
						:disabled="
							!ack || nh.blocked || unsupported || (action !== 'create' && !current)
						"
						:variant="action === 'delete' ? 'destructive' : 'default'"
						>{{ title }}</Button
					></DialogFooter
				>
			</form>
		</DialogContent></Dialog
	>
</template>
