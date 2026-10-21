<script setup lang="ts">
import { computed } from 'vue'
import WorkspaceTabs from '../../../shared/components/WorkspaceTabs.vue'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { entityPath } from '@shared/entity-management'
const sb = useServiceBus()
const items = computed(() =>
	sb.tabs.map((tab) => ({ id: tab.id, label: entityPath(tab.entity.target) })),
)
</script>
<template>
	<WorkspaceTabs
		:items="items"
		:active="sb.activeTabId"
		:disabled="!!sb.busy"
		label="Open entities"
		@select="sb.activateTab"
		@close="sb.closeTab"
	/>
</template>
