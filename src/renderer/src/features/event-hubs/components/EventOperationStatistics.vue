<script setup lang="ts">
import { computed } from 'vue'
import type { EventOperationStatistics } from '@shared/contracts/event-hubs/statistics'
const props = defineProps<{
	statistics?: EventOperationStatistics | null
	elapsedMs: number
	label: string
	sending?: boolean
}>()
const rate = (amount: number) =>
	props.elapsedMs > 0 ? ((amount * 1000) / props.elapsedMs).toFixed(2) : '—'
const ms = (amount: number | null | undefined) => (amount == null ? '—' : amount.toFixed(2) + ' ms')
const average = computed(() =>
	props.statistics?.successfulCalls
		? props.statistics.totalCallMs / props.statistics.successfulCalls
		: null,
)
</script>
<template>
	<section v-if="statistics" :aria-label="label" class="event-operation-statistics">
		<strong>{{ label }}</strong>
		<dl>
			<div>
				<dt>{{ sending ? 'Confirmed body bytes' : 'Retained body bytes' }}</dt>
				<dd>{{ statistics.bodyBytes.toLocaleString() }} B</dd>
			</div>
			<div>
				<dt>Events / second</dt>
				<dd>{{ rate(statistics.bodyEvents) }}</dd>
			</div>
			<div>
				<dt>Body bytes / second</dt>
				<dd>{{ rate(statistics.bodyBytes) }} B/s</dd>
			</div>
			<div>
				<dt>Body size min / average / max</dt>
				<dd>
					{{ statistics.minBodyBytes ?? '—' }} /
					{{
						statistics.bodyEvents
							? (statistics.bodyBytes / statistics.bodyEvents).toFixed(1)
							: '—'
					}}
					/ {{ statistics.maxBodyBytes ?? '—' }} B
				</dd>
			</div>
		</dl>
		<details>
			<summary>SDK {{ sending ? 'send' : 'receive' }} call timings</summary>
			<p>
				{{ statistics.successfulCalls }} successful ·
				{{ statistics.failedCalls }} failed/cancelled<span v-if="!sending">
					· {{ statistics.emptyCalls }} empty</span
				>
			</p>
			<p>
				Minimum {{ ms(statistics.minCallMs) }} · Average {{ ms(average) }} · Maximum
				{{ ms(statistics.maxCallMs) }} · Total {{ ms(statistics.totalCallMs) }}
			</p>
		</details>
		<p class="explorer-note">
			This operation only. Rates use total run time, including setup, waiting, pacing and
			cleanup. Body bytes exclude AMQP overhead. Timings cover successful SDK calls<span
				v-if="!sending"
				>, including empty waits</span
			>;
			{{
				sending
					? 'uncertain batches are excluded from counts and bytes'
					: 'concurrent call durations may overlap'
			}}.
		</p>
	</section>
</template>
<style scoped>
.event-operation-statistics {
	border: 1px solid var(--border);
	border-radius: 0.5rem;
	padding: 0.75rem;
	display: grid;
	gap: 0.5rem;
}
dl {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 0.65rem;
	margin: 0;
}
dt {
	font-size: 0.78rem;
	color: var(--muted-foreground);
}
dd {
	margin: 0.15rem 0 0;
	font-variant-numeric: tabular-nums;
}
p {
	margin: 0.4rem 0 0;
}
</style>
