<script setup lang="ts">
import { computed } from 'vue'
import type { TestJobResult } from '@shared/contracts/service-bus/test-jobs'
const props = defineProps<{ result: TestJobResult }>()
const timings = computed(() =>
	[
		{ label: 'Send batch', value: props.result.latency.send },
		{ label: 'Receive', value: props.result.latency.receive },
		{
			label: {
				complete: 'Complete',
				abandon: 'Abandon',
				defer: 'Defer',
				'dead-letter': 'Dead-letter',
			}[props.result.settlement],
			value: props.result.latency.settle,
		},
	].filter((row) =>
		props.result.mode === 'send' ? row.label === 'Send batch' : row.label !== 'Send batch',
	),
)
const ms = (value: number | null) => (value === null ? '—' : value.toFixed(2))
</script>
<template>
	<section aria-label="Test latency statistics" class="test-statistics">
		<h3>Latency (ms)</h3>
		<div class="statistics-scroll">
			<table class="property-table" aria-label="Operation latency">
				<thead>
					<tr>
						<th>Operation</th>
						<th>Samples</th>
						<th>Min</th>
						<th>Mean</th>
						<th>p50</th>
						<th>p95</th>
						<th>p99</th>
						<th>Max</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in timings" :key="row.label">
						<th scope="row">{{ row.label }}</th>
						<td>{{ row.value.samples }}</td>
						<td>{{ ms(row.value.minMs) }}</td>
						<td>{{ ms(row.value.meanMs) }}</td>
						<td>{{ ms(row.value.p50Ms) }}</td>
						<td>{{ ms(row.value.p95Ms) }}</td>
						<td>{{ ms(row.value.p99Ms) }}</td>
						<td>{{ ms(row.value.maxMs) }}</td>
					</tr>
				</tbody>
			</table>
		</div>
		<p class="explorer-note">
			Successful SDK calls only. Send samples are per batch; receive samples exclude empty
			reads and include waiting. These are operation times, not end-to-end delivery latency.
		</p>
		<details>
			<summary>Worker details</summary>
			<div class="statistics-scroll">
				<table class="property-table" aria-label="Test worker results">
					<thead>
						<tr>
							<th>Worker</th>
							<th>Sent</th>
							<th>Received</th>
							<th>Settled</th>
							<th>Uncertain</th>
							<th>Batches</th>
							<th>Reads</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="worker in result.workerResults" :key="worker.worker">
							<th scope="row">{{ worker.worker }}</th>
							<td>{{ worker.sent }}</td>
							<td>{{ worker.received }}</td>
							<td>{{ worker.settled }}</td>
							<td>{{ worker.uncertain }}</td>
							<td>{{ worker.sendBatches }}</td>
							<td>{{ worker.receiveCalls }}</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p
				v-for="worker in result.workerResults.filter((w) => w.uncertain)"
				:key="worker.worker"
				class="uncertain-identifiers"
			>
				Worker {{ worker.worker }} · uncertain IDs:
				{{ worker.uncertainMessageIds.join(', ') }}
				<span v-if="worker.uncertainSequenceNumber">
					· sequence {{ worker.uncertainSequenceNumber }}</span
				>
			</p>
		</details>
	</section>
</template>
<style scoped>
.test-statistics {
	margin-block: 1rem;
}
.test-statistics h3 {
	margin-bottom: 0.5rem;
	font-weight: 600;
}
.statistics-scroll {
	overflow-x: auto;
}
th,
td {
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}
th:not(:first-child),
td {
	text-align: right;
}
details {
	margin-top: 0.75rem;
}
summary {
	cursor: pointer;
}
.uncertain-identifiers {
	overflow-wrap: anywhere;
	font-family: monospace;
}
</style>
