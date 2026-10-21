<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { ChevronRight, RefreshCw } from '@lucide/vue'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { metrics, countText } from '@/features/service-bus/lib/entity-counts'
import { Button } from '@/shared/ui/button'
const monitor = useNamespaceMonitor(),
	sb = useServiceBus()
const workspace = useWorkspace()
const layout = useWorkspaceLayout()
async function changeInterval(event: Event) {
	try {
		await workspace.savePreferences({
			...workspace.preferences,
			countRefreshSeconds: Number((event.target as HTMLSelectElement).value),
		})
	} catch (cause) {
		workspace.error = cause instanceof Error ? cause.message : 'Preferences could not be saved.'
	}
}
onMounted(monitor.start)
onBeforeUnmount(monitor.stop)
</script>
<template>
	<section class="namespace-overview" aria-label="Namespace message counters">
		<div class="counter-toolbar">
			<button
				class="counter-disclosure"
				:aria-expanded="layout.namespaceCountersVisible"
				aria-controls="namespace-statistics"
				@click="layout.namespaceCountersVisible = !layout.namespaceCountersVisible"
			>
				<ChevronRight
					:size="14"
					:class="{ expanded: layout.namespaceCountersVisible }"
				/><strong>Namespace statistics</strong>
				<span v-if="monitor.issues.length" class="count"
					>{{ monitor.issues.length }} issues</span
				>
			</button>
			<span class="counter-status" role="status">
				{{
					monitor.refreshing
						? `Refreshing · ${monitor.scanned} entities`
						: monitor.updatedAt
							? `${monitor.stale ? 'Stale · ' : ''}${monitor.complete ? '' : 'Partial · '}Updated ${new Date(monitor.updatedAt).toLocaleTimeString()}`
							: 'Waiting for counts'
				}}
			</span>
			<label v-show="layout.namespaceCountersVisible"
				>Refresh
				<select
					:value="monitor.interval"
					aria-label="Counter refresh interval"
					@change="changeInterval"
				>
					<option
						v-if="![0, 10, 30, 60, 300].includes(monitor.interval)"
						:value="monitor.interval"
					>
						Every {{ monitor.interval }} seconds
					</option>
					<option :value="0">Paused</option>
					<option :value="10">Every 10 seconds</option>
					<option :value="30">Every 30 seconds</option>
					<option :value="60">Every minute</option>
					<option :value="300">Every 5 minutes</option>
				</select></label
			>
			<Button
				v-show="layout.namespaceCountersVisible"
				variant="ghost"
				size="icon-sm"
				aria-label="Refresh namespace counts"
				:disabled="monitor.refreshing || !!sb.busy"
				@click="monitor.refresh"
				><RefreshCw :size="14" :class="{ 'counter-spinning': monitor.refreshing }"
			/></Button>
		</div>
		<div id="namespace-statistics" v-show="layout.namespaceCountersVisible">
			<div class="namespace-counts">
				<div
					v-for="(label, key) in metrics"
					:key="key"
					:class="{
						'count-attention':
							(key === 'deadLetter' || key === 'transferDeadLetter') &&
							monitor.totals[key].value !== '0' &&
							monitor.updatedAt,
					}"
					:aria-label="label + ' count'"
				>
					<span>{{ label }}</span
					><strong :title="monitor.totals[key].value ?? 'Unavailable'">{{
						monitor.updatedAt
							? countText(monitor.totals[key].value, monitor.totals[key].partial)
							: '—'
					}}</strong>
				</div>
			</div>
			<p class="counter-caption">
				Counts may lag. Totals include queues and subscription copies; scheduled includes
				queues and topics.
			</p>
			<details v-if="monitor.issues.length" class="counter-issues">
				<summary>
					Counts incomplete · {{ monitor.issues.length }}
					{{ monitor.issues.length === 1 ? 'issue' : 'issues' }}
				</summary>
				<ul>
					<li v-for="issue in monitor.issues" :key="issue">{{ issue }}</li>
				</ul>
				<p>
					≥ means a known subtotal; — means unavailable. Failed refreshes retain the last
					snapshot.
				</p>
			</details>
		</div>
	</section>
</template>
