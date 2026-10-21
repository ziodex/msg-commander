<script setup lang="ts">
import { computed } from 'vue'
import { jsonTokens } from '@/shared/lib/message-body'
const props = defineProps<{ text: string }>()
const tokens = computed(() => jsonTokens(props.text))
</script>
<template>
	<pre
		class="body-preview json-body"
	><template v-for="(token, index) in tokens" :key="index"><span v-if="token.kind !== 'plain'" :class="'json-' + token.kind">{{ token.text }}</span><template v-else>{{ token.text }}</template></template></pre>
</template>
<style scoped>
.json-body {
	color: var(--foreground);
}
.json-key {
	color: #075985;
	font-weight: 600;
}
.json-string {
	color: #166534;
}
.json-number {
	color: #9a3412;
}
.json-boolean {
	color: #6b21a8;
}
.json-null {
	color: #9f1239;
}
.dark .json-key {
	color: #7dd3fc;
}
.dark .json-string {
	color: #86efac;
}
.dark .json-number {
	color: #fdba74;
}
.dark .json-boolean {
	color: #d8b4fe;
}
.dark .json-null {
	color: #fda4af;
}
</style>
