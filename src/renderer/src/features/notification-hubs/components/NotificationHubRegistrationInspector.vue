<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import JsonBody from '../../../shared/components/JsonBody.vue'
import type { NotificationHubRegistrationDetails } from '@shared/contracts/notification-hubs/registrations'
import { legacyRegistrationWarning } from '@shared/contracts/notification-hubs/compatibility'
const props = defineProps<{
	details: NotificationHubRegistrationDetails
	busy: boolean
	blocked: boolean
}>()
const emit = defineEmits<{
	close: []
	edit: []
	delete: []
	refresh: []
	export: []
}>()
const template = computed(() => {
	try {
		return JSON.stringify(JSON.parse(props.details.templateBody ?? ''), null, 2)
	} catch {
		return props.details.templateBody
	}
})
</script>
<template>
	<Dialog :open="true" @update:open="!$event && emit('close')"
		><DialogContent class="sm:max-w-[920px] nh-dialog nh-registration-inspector"
			><DialogHeader
				><DialogTitle>Registration inspection</DialogTitle
				><DialogDescription
					>Read-only snapshot · captured
					{{ new Date(details.capturedAt).toLocaleString() }}</DialogDescription
				></DialogHeader
			>
			<p v-if="details.warning" class="form-warning">{{ details.warning }}</p>
			<p v-if="legacyRegistrationWarning(details.registration.kind)" class="form-warning">
				{{ legacyRegistrationWarning(details.registration.kind) }}
			</p>
			<dl class="nh-registration-properties">
				<dt>Registration ID</dt>
				<dd>{{ details.registration.registrationId }}</dd>
				<dt>Platform</dt>
				<dd>
					{{ details.registration.platform }} ·
					{{ details.registration.template ? 'Template' : 'Native' }}
				</dd>
				<dt>Registration type</dt>
				<dd>{{ details.registration.kind }}</dd>
				<dt>ETag</dt>
				<dd>{{ details.etag ?? 'Not supplied' }}</dd>
				<dt>Expiration</dt>
				<dd>{{ details.registration.expirationTime ?? 'Not supplied' }}</dd>
				<dt>Tags</dt>
				<dd>{{ details.registration.tags.join(', ') || 'None' }}</dd>
				<dt>Device handle</dt>
				<dd class="nh-device-handle">
					{{ details.registration.handle ?? 'See original XML' }}
				</dd>
			</dl>
			<section v-if="template">
				<h3>Template body</h3>
				<JsonBody :text="template" />
			</section>
			<details>
				<summary>Original registration XML (all fields)</summary>
				<pre class="body-preview nh-registration-xml">{{ details.rawXml }}</pre>
			</details>
			<div class="nh-actions">
				<Button variant="outline" :disabled="busy" @click="emit('refresh')"
					>Refresh registration</Button
				>
				<Button variant="outline" :disabled="busy" @click="emit('export')"
					>Export registration…</Button
				>
				<Button :disabled="blocked" @click="emit('edit')">Edit registration…</Button>

				<Button variant="destructive" :disabled="blocked" @click="emit('delete')"
					>Delete registration…</Button
				>
				<Button variant="outline" :disabled="busy" @click="emit('close')"
					>Close registration inspection</Button
				>
			</div>
		</DialogContent></Dialog
	>
</template>
