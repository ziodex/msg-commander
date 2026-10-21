<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import {
	notificationFormatLabels,
	type NotificationOutcome,
} from '@shared/contracts/notification-hubs/notifications'
import JsonBody from '../../../shared/components/JsonBody.vue'
const props = defineProps<{ outcome: NotificationOutcome }>(),
	emit = defineEmits<{ close: [] }>()
const payload = computed(() => {
	if (props.outcome.draft.format === 'template')
		return JSON.stringify(
			Object.fromEntries(props.outcome.draft.parameters.map((p) => [p.name, p.value])),
			null,
			2,
		)
	try {
		return JSON.stringify(JSON.parse(props.outcome.draft.body), null, 2)
	} catch {
		return props.outcome.draft.body
	}
})
</script>
<template>
	<Dialog :open="true" @update:open="!$event && emit('close')"
		><DialogContent class="sm:max-w-[1020px] notification-dialog"
			><DialogHeader
				><DialogTitle>Notification send result</DialogTitle
				><DialogDescription
					>{{ outcome.status }} · {{ new Date(outcome.capturedAt).toLocaleString() }} ·
					Receipt {{ outcome.operationId }}</DialogDescription
				></DialogHeader
			>
			<div class="notification-dialog-body">
				<p class="field-hint">{{ outcome.summary }}</p>
				<dl class="nh-registration-properties">
					<dt>Format</dt>
					<dd>{{ notificationFormatLabels[outcome.draft.format] }}</dd>
					<dt>Target</dt>
					<dd>
						{{
							outcome.draft.target === 'tags'
								? outcome.draft.tagExpression
								: 'Broadcast (Azure test limit: 10 devices)'
						}}
					</dd>
					<template v-if="outcome.details"
						><dt>Provider successes</dt>
						<dd>{{ outcome.details.success ?? 'Unavailable' }}</dd>
						<dt>Provider failures</dt>
						<dd>{{ outcome.details.failure ?? 'Unavailable' }}</dd>
						<dt>Tracking ID</dt>
						<dd>{{ outcome.details.trackingId }}</dd>
						<dt v-if="outcome.details.notificationId">Notification ID</dt>
						<dd v-if="outcome.details.notificationId">
							{{ outcome.details.notificationId }}
						</dd></template
					>
				</dl>
				<p v-if="outcome.details?.warning" class="form-warning">
					{{ outcome.details.warning }}
				</p>
				<p
					v-if="
						outcome.details &&
						outcome.details.success === 0 &&
						outcome.details.failure === 0
					"
					class="field-hint"
				>
					Azure reported no device outcomes. Check matching registrations, template
					parameters and provider configuration; no delivery is implied.
				</p>
				<div v-if="outcome.details?.results.length" class="notification-results">
					<h3>Per-device push-provider outcomes</h3>
					<p class="field-hint">
						These outcomes do not confirm that an application displayed or processed a
						notification.
					</p>
					<table class="nh-policy-table">
						<thead>
							<tr>
								<th>Platform</th>
								<th>Registration</th>
								<th>Outcome</th>
								<th>Device handle</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="(row, index) in outcome.details.results" :key="index">
								<td>{{ row.platform }}</td>
								<td>{{ row.registrationId }}</td>
								<td>{{ row.outcome }}</td>
								<td class="notification-handle">{{ row.pnsHandle }}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<details>
					<summary>Sent payload and platform headers</summary>
					<JsonBody :text="payload" /><JsonBody
						v-if="outcome.draft.headers.length"
						:text="JSON.stringify(outcome.draft.headers, null, 2)"
					/>
				</details>
				<details v-if="outcome.details?.rawXml">
					<summary>Original Azure outcome XML</summary>
					<pre class="body-preview nh-registration-xml">{{ outcome.details.rawXml }}</pre>
				</details>
			</div>
			<div class="nh-actions notification-dialog-actions">
				<Button variant="outline" @click="emit('close')">Close send result</Button>
			</div></DialogContent
		></Dialog
	>
</template>
<style>
.notification-results {
	margin: 16px 0;
	overflow: auto;
}
.notification-handle {
	max-width: 300px;
	overflow-wrap: anywhere;
}
.notification-dialog-body > details {
	margin-top: 16px;
	font-size: 12px;
}
</style>
