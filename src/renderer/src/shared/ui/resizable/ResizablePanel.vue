<script setup lang="ts">
import type { SplitterPanelEmits, SplitterPanelProps } from 'reka-ui'
import { SplitterPanel, useForwardPropsEmits } from 'reka-ui'
import { computed, ref } from 'vue'

const props = defineProps<SplitterPanelProps>()
const emits = defineEmits<SplitterPanelEmits>()

const forwarded = useForwardPropsEmits(props, emits)
const panel = ref<InstanceType<typeof SplitterPanel>>()
defineExpose({
	collapse: () => panel.value?.collapse(),
	expand: () => panel.value?.expand(),
	resize: (size: number) => panel.value?.resize(size),
	getSize: () => panel.value?.getSize(),
	isCollapsed: computed(() => panel.value?.isCollapsed ?? false),
	isExpanded: computed(() => panel.value?.isExpanded ?? true),
})
</script>

<template>
	<SplitterPanel ref="panel" v-slot="slotProps" data-slot="resizable-panel" v-bind="forwarded">
		<slot v-bind="slotProps" />
	</SplitterPanel>
</template>
