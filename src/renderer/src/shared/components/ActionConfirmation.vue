<script setup lang="ts">
import { watch } from 'vue'
const props = defineProps<{
	expected: string
	label: string
	disabled?: boolean
	context?: string
}>()
const model = defineModel<string>({ required: true })
watch(
	() => [props.expected, props.context],
	() => {
		model.value = ''
	},
	{ flush: 'sync' },
)
</script>
<template>
	<label class="checkbox-label"
		><input
			type="checkbox"
			:checked="!!expected && model === expected"
			:disabled="disabled"
			@change="model = ($event.target as HTMLInputElement).checked ? expected : ''"
		/>{{ label }}</label
	>
</template>
