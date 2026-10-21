<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import type { MessageDraft } from '@shared/message-operations'
import type { ImportPreview, ImportMessagesRequest } from '@shared/message-files'
const props = defineProps<{ disabled: boolean; accept: (drafts: MessageDraft[]) => boolean }>()
const sb = useServiceBus()
const format = ref<ImportMessagesRequest['format']>('archive')
const mode = ref<'full' | 'body'>('full')
const policy = ref<'new' | 'preserve'>('new')
const preview = ref<ImportPreview>()
const selected = ref<string[]>([])
let disposed = false
const eligible = computed(
	() =>
		preview.value?.items.filter(
			(item) => !(mode.value === 'full' ? item.fullIssue : item.bodyIssue),
		) ?? [],
)
function chooseDefaults() {
	selected.value = eligible.value.slice(0, 20).map((item) => item.id)
}
watch(mode, chooseDefaults)
watch(format, discard)
async function open() {
	discard()
	const result = await sb.importMessages(format.value)
	if (result && !result.cancelled) {
		if (disposed) {
			if (result.importId) sb.discardImport(result.importId)
			return
		}
		preview.value = result
		chooseDefaults()
	}
}
function discard() {
	if (preview.value?.importId) sb.discardImport(preview.value.importId)
	preview.value = undefined
	selected.value = []
}
onBeforeUnmount(() => {
	disposed = true
	discard()
})
async function load() {
	if (!preview.value?.importId) return
	const result = await sb.loadImported(
		preview.value.importId,
		selected.value,
		mode.value,
		policy.value,
	)
	if (!disposed && result && props.accept(result.drafts)) discard()
}
</script>
<template>
	<section class="message-import" aria-label="Message file import">
		<div class="explorer-actions">
			<label
				>File format<select
					v-model="format"
					aria-label="Import file format"
					class="commander-select"
					:disabled="disabled"
				>
					<option value="archive">Commander archive (.msgc.json)</option>

					<option value="body">Body files (JSON, text or binary)</option>
				</select></label
			>
			<Button type="button" variant="outline" :disabled="disabled" @click="open"
				>Import message files</Button
			>
		</div>
		<p class="explorer-note">
			Choose files, review their messages and add selected drafts to the batch. Import never
			sends messages. Existing drafts are kept.
		</p>

		<template v-if="preview?.importId">
			<div class="composer-grid">
				<label
					>Import content<select
						v-model="mode"
						aria-label="Import content"
						class="commander-select"
						:disabled="disabled"
					>
						<option value="full">Body and supported metadata</option>
						<option value="body">Body only (omit all metadata)</option>
					</select></label
				>
				<label
					>Message IDs<select
						v-model="policy"
						aria-label="Imported message IDs"
						class="commander-select"
						:disabled="disabled"
					>
						<option value="new">Generate new IDs</option>
						<option value="preserve">Preserve original IDs</option>
					</select></label
				>
			</div>
			<p v-if="policy === 'preserve'" class="inspector-warning">
				Preserved IDs can trigger destination duplicate detection. Select new IDs for
				repeated copies.
			</p>
			<p v-if="mode === 'body'" class="inspector-warning">
				Body only omits headers, TTL and every application property. Content type becomes
				application/octet-stream; review session requirements before sending.
			</p>
			<p class="explorer-note">
				Broker-assigned fields and old scheduled times stay in the archive. TTL starts again
				on sending. Select at most 20 messages that fit the 512 KiB batch budget. This is a
				copy; source messages remain unchanged.
			</p>
			<div class="import-list">
				<label v-for="item in preview.items" :key="item.id" class="import-row">
					<input
						v-model="selected"
						type="checkbox"
						:value="item.id"
						:aria-label="'Import ' + item.fileName + ' message ' + item.index"
						:disabled="
							disabled || !!(mode === 'full' ? item.fullIssue : item.bodyIssue)
						"
					/>
					<span
						><strong>{{ item.fileName }} · {{ item.index }}</strong
						><br />{{ item.messageId ?? '(new message)' }} ·
						{{ item.bodySize }} bytes<br /><small
							v-if="mode === 'full' ? item.fullIssue : item.bodyIssue"
							>{{ mode === 'full' ? item.fullIssue : item.bodyIssue }}</small
						><small
							v-for="warning in item.warnings"
							:key="warning"
							class="import-migration-note"
							>{{ warning }}</small
						></span
					>
				</label>
			</div>
			<div class="explorer-actions">
				<Button
					type="button"
					:disabled="disabled || !selected.length || selected.length > 20"
					@click="load"
					>Add selected to batch ({{ selected.length }})</Button
				><Button type="button" variant="ghost" :disabled="disabled" @click="discard"
					>Discard import preview</Button
				>
			</div>
		</template>
		<p v-if="sb.error" role="alert" class="error-banner">{{ sb.error }}</p>
	</section>
</template>
<style scoped>
.import-migration-note {
	display: block;
	margin-top: 4px;
	color: var(--muted-foreground);
	overflow-wrap: anywhere;
}
</style>
