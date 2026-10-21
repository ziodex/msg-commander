<script setup lang="ts">
import { eventHubsApi } from '@/features/event-hubs/api'

import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { useEventHubs } from '@/features/event-hubs/stores/event-hubs'
import { useEventHubsAdmin } from '@/features/event-hubs/stores/event-hubs-admin'
import { useWorkspace } from '@/shared/workspace/store'
import { eventAdminPath } from '@shared/contracts/event-hubs/administration'
const eh = useEventHubs(),
	admin = useEventHubsAdmin(),
	workspace = useWorkspace(),
	review = ref(false)
const job = computed(() =>
	workspace.jobs.find((j) => j.id === eh.operationId && j.status === 'running'),
)
watch(
	() => admin.outcome,
	() => {
		review.value = false
	},
)
async function login() {
	await eventHubsApi.openDeviceLogin()
}
</script>
<template>
	<p v-if="eh.error" role="alert" class="error-banner">{{ eh.error }}</p>
	<section v-if="eh.busy" aria-label="Event administration progress" class="admin-feedback">
		<p role="status">{{ eh.busy }}…</p>
		<template v-if="job?.code"
			><p class="device-code">{{ job.code }}</p>
			<Button variant="outline" @click="login">Open Microsoft sign-in</Button></template
		>
		<Button variant="outline" @click="eh.cancel">Cancel administration operation</Button>
	</section>
	<section v-if="admin.outcome" aria-label="Event administration result" class="admin-feedback">
		<p role="status">{{ admin.outcome.summary }}</p>
		<p class="explorer-note">
			{{ admin.outcome.action }} · {{ eventAdminPath(admin.outcome.target) }} ·
			{{ admin.outcome.status }} · Receipt {{ admin.outcome.operationId }}
		</p>
		<template v-if="admin.outcome.status === 'unknown'">
			<Button variant="outline" :disabled="!!eh.busy" @click="admin.recover"
				>Check administration receipt</Button
			>
			<template v-if="!admin.reviewed"
				><p class="inspector-warning">
					Refresh and inspect the affected resource before another change. A key rotation
					may have succeeded even when policy rights are unchanged.
				</p>
				<label class="check-row"
					><input v-model="review" type="checkbox" :disabled="!!eh.busy" />I reviewed
					Azure state and the risk of repeating this change.</label
				>
				<Button
					variant="outline"
					:disabled="!!eh.busy || !review"
					@click="admin.reviewed = true"
					>Allow another administration change</Button
				>
			</template>
		</template>
	</section>
</template>
<style scoped>
.admin-feedback {
	display: grid;
	gap: 0.65rem;
	padding: 0.8rem;
	border: 1px solid var(--border);
	border-radius: 0.5rem;
}
.explorer-note {
	overflow-wrap: anywhere;
}
.check-row {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
}
</style>
