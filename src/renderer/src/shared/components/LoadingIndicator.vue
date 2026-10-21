<script setup lang="ts">
import { LoaderCircle } from '@lucide/vue'
withDefaults(defineProps<{ label: string; announce?: boolean }>(), { announce: true })
</script>

<template>
	<div
		class="loading-indicator"
		:role="announce ? 'status' : undefined"
		:aria-live="announce ? 'polite' : undefined"
	>
		<LoaderCircle class="loading-spinner" :size="18" aria-hidden="true" />
		<span>{{ label }}</span>
		<slot />
	</div>
</template>

<style scoped>
.loading-indicator {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 12px;
	margin-block: 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--muted);
	font-size: 13px;
}
.loading-spinner {
	flex-shrink: 0;
	animation: loading-spin 1s linear infinite;
}
@keyframes loading-spin {
	to {
		transform: rotate(360deg);
	}
}
@media (prefers-reduced-motion: reduce) {
	.loading-spinner {
		animation: none;
	}
}
</style>
