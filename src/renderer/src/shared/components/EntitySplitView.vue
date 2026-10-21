<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useElementSize } from '@vueuse/core'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable'
import { useWorkspaceLayout } from '@/shared/workspace/layout'

defineProps<{ storageKey: string }>()
const layout = useWorkspaceLayout()
const root = ref<HTMLElement>()
const tree = ref<InstanceType<typeof ResizablePanel>>()
const { width } = useElementSize(root)
const minimum = computed(() => Math.min(35, (180 / (width.value || 800)) * 100))
const maximum = computed(() =>
	Math.max(minimum.value, Math.min(55, 100 - (320 / (width.value || 800)) * 100)),
)
let initialized = false
function setVisibility(visible: boolean) {
	if (initialized) layout.treeVisible = visible
}
watch(
	() => layout.resetVersion,
	() => tree.value?.resize(27),
)
watch(
	() => layout.treeVisible,
	(visible) => {
		if (visible) tree.value?.expand()
		else tree.value?.collapse()
	},
)
onMounted(() => {
	if (!layout.treeVisible) tree.value?.collapse()
	else if (tree.value?.isCollapsed) tree.value?.expand()
	initialized = true
})
</script>

<template>
	<div ref="root" class="entity-layout resizable-entity-layout">
		<ResizablePanelGroup direction="horizontal" :auto-save-id="storageKey" class="entity-split">
			<ResizablePanel
				ref="tree"
				:id="storageKey + '-tree'"
				:default-size="27"
				:min-size="minimum"
				:max-size="maximum"
				:collapsible="true"
				:collapsed-size="0"
				class="entity-tree-panel"
				@collapse="setVisibility(false)"
				@expand="setVisibility(true)"
			>
				<div v-show="layout.treeVisible" class="entity-tree-content">
					<slot name="tree" />
				</div>
			</ResizablePanel>
			<ResizableHandle
				v-show="layout.treeVisible"
				aria-label="Resize entities column"
				title="Drag to resize · Arrow keys to adjust"
				class="entity-divider"
			/>
			<ResizablePanel
				:id="storageKey + '-content'"
				:default-size="73"
				:min-size="35"
				class="entity-content-panel"
			>
				<slot />
			</ResizablePanel>
		</ResizablePanelGroup>
	</div>
</template>
