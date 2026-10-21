<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import { useNotificationSender } from '@/features/notification-hubs/stores/notification-hub-notifications'
import {
	defaultNotification,
	notificationDraftSchema,
	notificationFormats,
	notificationFormatLabels,
	notificationHeaders,
} from '@shared/contracts/notification-hubs/notifications'
import JsonBody from '../../../shared/components/JsonBody.vue'
const sender = useNotificationSender(),
	draft = ref(defaultNotification()),
	acknowledge = ref(false),
	error = ref(''),
	preview = ref(false)
const valid = computed(() => notificationDraftSchema.safeParse(draft.value))
watch(
	() => draft.value.format,
	(format) => {
		const { target, tagExpression } = draft.value
		draft.value = { ...defaultNotification(format), target, tagExpression }
		error.value = ''
	},
)
watch(
	() => draft.value.target,
	(target) => {
		if (target === 'broadcast') draft.value.tagExpression = ''
	},
)
watch(
	draft,
	() => {
		acknowledge.value = false
		error.value = ''
	},
	{ deep: true },
)
const payload = computed(() =>
	draft.value.format === 'template'
		? JSON.stringify(
				Object.fromEntries(draft.value.parameters.map((p) => [p.name, p.value])),
				null,
				2,
			)
		: draft.value.body,
)
async function send() {
	if (!valid.value.success) {
		error.value = valid.value.error.issues[0].message
		return
	}
	if (!acknowledge.value) return
	await sender.send(valid.value.data)
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && !sender.busy && (sender.composer = false)"
		><DialogContent
			class="sm:max-w-[920px] notification-dialog"
			:show-close-button="!sender.busy"
			><DialogHeader
				><DialogTitle>Compose test notification</DialogTitle
				><DialogDescription
					>{{ sender.connection?.hubName }} · {{ sender.connection?.namespace }} · Azure
					test mode, up to 10 devices</DialogDescription
				></DialogHeader
			>
			<div class="notification-dialog-body nh-form">
				<label
					>Notification format<select
						v-model="draft.format"
						aria-label="Notification format"
						:disabled="!!sender.busy"
					>
						<option v-for="format in notificationFormats" :key="format" :value="format">
							{{ notificationFormatLabels[format] }}
						</option>
					</select></label
				>
				<div class="nh-fields">
					<label
						>Notification target<select
							v-model="draft.target"
							aria-label="Notification target"
							:disabled="!!sender.busy"
						>
							<option value="tags">Tag expression</option>
							<option value="broadcast">
								Broadcast to all matching registrations
							</option>
						</select></label
					><label v-if="draft.target === 'tags'"
						>Tag expression<Input
							v-model="draft.tagExpression"
							:disabled="!!sender.busy"
							placeholder="news && !muted"
					/></label>
				</div>
				<p v-if="draft.target === 'tags'" class="field-hint">
					Use && (AND), || (OR), ! (NOT) and parentheses. Maximum 20 OR tags, 10 AND tags
					or 6 combined. Matching is case-sensitive.
				</p>
				<p v-else class="form-warning">
					Broadcast selects all registrations for the chosen format, subject to Azure's
					10-device test limit.
				</p>
				<template v-if="draft.format === 'template'"
					><h3>Template parameters</h3>
					<p class="field-hint">
						String values replace parameters in matching registered templates. Names are
						case-insensitive. Missing parameters resolve to empty strings.
					</p>
					<div
						v-for="(parameter, index) in draft.parameters"
						:key="index"
						class="nh-tag-row"
					>
						<Input
							v-model="parameter.name"
							:aria-label="`Parameter ${index + 1} name`"
							:disabled="!!sender.busy"
						/><Input
							v-model="parameter.value"
							:aria-label="`Parameter ${index + 1} value`"
							:disabled="!!sender.busy"
						/><Button
							variant="ghost"
							:aria-label="`Remove parameter ${index + 1}`"
							:disabled="!!sender.busy"
							@click="draft.parameters.splice(index, 1)"
							>Remove</Button
						>
					</div>
					<Button
						variant="outline"
						:disabled="!!sender.busy || draft.parameters.length >= 100"
						@click="draft.parameters.push({ name: '', value: '' })"
						>Add template parameter</Button
					></template
				>
				<label v-else
					>Native notification payload<textarea
						v-model="draft.body"
						aria-label="Native notification payload"
						rows="10"
						spellcheck="false"
						:disabled="!!sender.busy"
					/>
				</label>

				<template v-if="notificationHeaders[draft.format].length"
					><h3>Platform headers</h3>
					<div v-for="(header, index) in draft.headers" :key="index" class="nh-tag-row">
						<select
							v-model="header.name"
							:aria-label="`Header ${index + 1} name`"
							:disabled="!!sender.busy"
						>
							<option v-for="name in notificationHeaders[draft.format]" :key="name">
								{{ name }}
							</option></select
						><Input
							v-model="header.value"
							:aria-label="`Header ${index + 1} value`"
							:disabled="!!sender.busy"
						/><Button
							variant="ghost"
							:aria-label="`Remove header ${index + 1}`"
							:disabled="!!sender.busy"
							@click="draft.headers.splice(index, 1)"
							>Remove</Button
						>
					</div>
					<Button
						variant="outline"
						:disabled="!!sender.busy || draft.headers.length >= 12"
						@click="
							draft.headers.push({
								name: notificationHeaders[draft.format][0],
								value: '',
							})
						"
						>Add platform header</Button
					></template
				>
				<p class="field-hint">
					Payload limit: 64 KiB UTF-8. Push providers may impose smaller limits. Provider
					credentials must already be configured on the hub. FCM v1 replaces retired
					GCM/FCM native sends. Microsoft no longer supports MPNS; legacy requests remain
					available for compatibility.
				</p>
				<Button variant="ghost" size="sm" @click="preview = !preview"
					>{{ preview ? 'Hide' : 'Show' }} payload preview</Button
				><JsonBody v-if="preview" :text="payload" />
				<label class="checkbox-label"
					><input v-model="acknowledge" type="checkbox" :disabled="!!sender.busy" />I
					reviewed the hub, target and payload. This test sends real notifications to
					devices.</label
				>
				<p v-if="error || (!valid.success && acknowledge)" class="form-error" role="alert">
					{{ error || (!valid.success ? valid.error.issues[0].message : '') }}
				</p>
				<p v-if="sender.error" class="form-error" role="alert">{{ sender.error }}</p>
			</div>
			<div class="nh-actions notification-dialog-actions">
				<Button :disabled="sender.blocked || !acknowledge || !valid.success" @click="send"
					>Send test notification</Button
				><Button v-if="sender.busy" variant="outline" @click="sender.cancel()"
					>Cancel notification operation</Button
				><Button v-else variant="outline" @click="sender.composer = false"
					>Close composer</Button
				><span v-if="sender.busy" role="status">Sending…</span>
			</div>
		</DialogContent></Dialog
	>
</template>
<style>
.notification-dialog {
	display: flex;
	flex-direction: column;
	max-height: 88vh;
	overflow: hidden;
}
.notification-dialog-body {
	overflow: auto;
	min-height: 0;
	padding-right: 4px;
	margin-top: 0;
}
.notification-dialog-actions {
	flex-shrink: 0;
	border-top: 1px solid var(--border);
	padding-top: 12px;
}
.notification-dialog select,
.notification-dialog textarea {
	width: 100%;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	color: var(--foreground);
	padding: 8px;
	font-size: 13px;
}
.notification-dialog textarea {
	font-family: var(--font-mono, monospace);
}
.notification-dialog .nh-tag-row {
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
}
</style>
