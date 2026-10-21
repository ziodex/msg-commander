<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/shared/ui/button'
import BodyCodecDialog from './BodyCodecDialog.vue'
const props = defineProps<{
	bytes?: Uint8Array
	base64?: string
	disabled?: boolean
	sourceKey?: string
	allowApply?: boolean
}>()
const emit = defineEmits<{ apply: [base64: string] }>()
const open = ref(false),
	initial = ref<string>()
function show() {
	initial.value = props.base64
	if (props.bytes) {
		let binary = ''
		for (let i = 0; i < props.bytes.length; i += 8192)
			binary += String.fromCharCode(...props.bytes.subarray(i, i + 8192))
		initial.value = btoa(binary)
	}
	open.value = true
}
</script>
<template>
	<Button type="button" variant="outline" size="sm" :disabled="disabled" @click="show"
		>Body tools…</Button
	><BodyCodecDialog
		v-model:open="open"
		:initial-base64="initial"
		:source-key="sourceKey"
		:allow-apply="allowApply"
		@apply="emit('apply', $event)"
	/>
</template>
