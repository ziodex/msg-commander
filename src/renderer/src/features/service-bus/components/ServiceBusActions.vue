<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import {
	DropdownMenuRoot,
	DropdownMenuTrigger,
	DropdownMenuPortal,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
} from 'reka-ui'
import { Button } from '@/shared/ui/button'
import BulkEntityManager from './BulkEntityManager.vue'
import BulkPurge from './BulkPurge.vue'
import { MessagingConfiguration } from '@/features/resource-configuration'
import { TestJobs } from '@/features/service-bus/test-jobs'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'

const sb = useServiceBus(),
	tree = useEntityTree()
const bulk = ref<InstanceType<typeof BulkEntityManager>>()
const purge = ref<InstanceType<typeof BulkPurge>>()
const config = ref<InstanceType<typeof MessagingConfiguration>>()
const tests = ref<InstanceType<typeof TestJobs>>()
const opened = ref(false)
const trigger = ref<InstanceType<typeof Button>>()
let handingOff = false
function onOpenChange(value: boolean) {
	if (value) handingOff = false
}
function restoreFocus(event: Event) {
	if (handingOff) event.preventDefault()
}
async function run(action: () => void) {
	handingOff = true
	opened.value = false
	;(trigger.value?.$el as HTMLElement)?.focus()
	await nextTick()
	action()
}
defineExpose({
	openBulk: () => bulk.value?.open(),
	openTest: (...args: Parameters<NonNullable<typeof tests.value>['open']>) =>
		tests.value?.open(...args),
})
</script>

<template>
	<DropdownMenuRoot v-model:open="opened" @update:open="onOpenChange">
		<DropdownMenuTrigger as-child>
			<Button ref="trigger" variant="outline" size="sm"
				>Actions<ChevronDown :size="14"
			/></Button>
		</DropdownMenuTrigger>
		<DropdownMenuPortal>
			<DropdownMenuContent
				class="entity-context-menu namespace-actions-menu"
				align="end"
				:side-offset="6"
				:collision-padding="8"
				@close-auto-focus="restoreFocus"
			>
				<DropdownMenuItem :disabled="!!sb.busy" @select="run(() => bulk?.open())"
					>Bulk entities…</DropdownMenuItem
				>
				<DropdownMenuItem :disabled="!!sb.busy" @select="run(() => config?.open())"
					>Service Bus configuration…</DropdownMenuItem
				>
				<DropdownMenuItem
					:disabled="
						(!sb.selected && !tests?.hasResult) || (!!sb.busy && !tests?.running)
					"
					@select="run(() => tests?.show())"
					>{{ tests?.hasResult ? 'Test job result' : 'Test jobs…' }}</DropdownMenuItem
				>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					class="destructive"
					:disabled="!!sb.busy"
					@select="run(() => purge?.open())"
					>Bulk purge…</DropdownMenuItem
				>
			</DropdownMenuContent>
		</DropdownMenuPortal>
	</DropdownMenuRoot>
	<BulkEntityManager ref="bulk" :hide-trigger="true" />
	<BulkPurge ref="purge" :hide-trigger="true" />
	<TestJobs ref="tests" :hide-trigger="true" />
	<MessagingConfiguration
		ref="config"
		:hide-trigger="true"
		service="service-bus"
		:connection="sb"
		:scope="
			sb.selected
				? {
						kind: sb.selected.target.kind,
						name: sb.selected.target.name,
						parentKind: sb.selected.target.kind === 'subscription' ? 'topic' : null,
						parentName:
							sb.selected.target.kind === 'subscription'
								? sb.selected.target.topicName
								: null,
					}
				: null
		"
		@changed="tree.refresh()"
	/>
</template>
