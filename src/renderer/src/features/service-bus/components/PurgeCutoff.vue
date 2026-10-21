<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@/shared/ui/input'
import {
	selectedPurgeCutoff,
	describePurgeCutoff,
	type PurgeCutoffSelection,
} from '@shared/purge-cutoff'
const selection = defineModel<PurgeCutoffSelection>({ required: true })
const cutoff = computed(() => selectedPurgeCutoff(selection.value))
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
</script>
<template>
	<div class="purge-manager">
		<label class="purge-ack"
			><input v-model="selection.enabled" type="checkbox" />Only purge messages older than a
			selected date and time</label
		>
		<template v-if="selection.enabled">
			<div class="explorer-actions">
				<label
					>Enqueued before<Input
						v-model="selection.dateTime"
						type="datetime-local"
						step="1"
						aria-label="Purge cutoff date and time"
				/></label>
				<label
					>Time zone<select v-model="selection.zone" aria-label="Purge cutoff time zone">
						<option value="local">Local ({{ localZone }})</option>
						<option value="utc">UTC</option>
					</select></label
				>
			</div>
			<p v-if="cutoff" class="write-destination">
				Enqueued strictly before {{ describePurgeCutoff(cutoff) }}. Messages at this exact
				time are kept.
			</p>
			<p v-else class="inline-error" role="alert">
				Choose a valid date and time. For a missing or repeated local clock time during a
				daylight-saving change, select UTC.
			</p>
			<p class="explorer-note">
				Uses the broker enqueue time, including in dead-letter queues; this is not the time
				of dead-lettering. Newer messages are left unsettled and may stay locked until
				expiry. Scanning stops after 100 retained messages per subqueue or on redelivery;
				older messages may remain. Receiving can affect delivery counts.
			</p>
		</template>
	</div>
</template>
