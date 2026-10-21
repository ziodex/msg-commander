<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { useWorkspace } from '@/shared/workspace/store'
import { testJobsApi } from '../api'
import { decodeBase64, hexPreview } from '@/shared/lib/message-body'
import type { TestGenerator, TestPayloadResult } from '@shared/contracts/service-bus/test-jobs'
const props = defineProps<{ generator: TestGenerator; body: string; contentType: string }>()
const emit = defineEmits<{
	'update:generator': [TestGenerator]
	'update:body': [string]
	'update:contentType': [string]
}>()
const workspace = useWorkspace()
const kind = computed({
	get: () => props.generator.kind,
	set: (kind) => emit('update:generator', { ...props.generator, kind }),
})
const seed = computed({
	get: () => props.generator.seed,
	set: (seed) => emit('update:generator', { ...props.generator, seed }),
})
const size = computed({
	get: () => props.generator.sizeBytes,
	set: (sizeBytes) => emit('update:generator', { ...props.generator, sizeBytes }),
})
const body = computed({ get: () => props.body, set: (value) => emit('update:body', value) })
const contentType = computed({
	get: () => props.contentType,
	set: (value) => emit('update:contentType', value),
})
const preview = ref<TestPayloadResult>(),
	error = ref(''),
	busy = ref(false)
let generation = 0
watch(
	() => [props.generator, props.body, props.contentType],
	() => {
		generation++
		preview.value = undefined
		error.value = ''
	},
	{ deep: true, flush: 'sync' },
)
const previewText = computed(() => {
	if (!preview.value) return ''
	const bytes = decodeBase64(preview.value.contentBase64)
	return props.generator.kind === 'binary'
		? hexPreview(bytes.slice(0, 64))
		: new TextDecoder().decode(bytes.slice(0, 4096))
})
async function showPreview() {
	const ticket = ++generation
	busy.value = true
	error.value = ''
	preview.value = undefined
	try {
		const value = await workspace.perform('Preview test payload', async (id) =>
			testJobsApi.previewPayload({
				id,
				generator: { ...props.generator },
				body: props.generator.kind === 'binary' ? '' : props.body,
				contentType: props.generator.kind === 'literal' ? props.contentType : '',
				sampleIndex: 1,
			}),
		)
		if (ticket === generation) preview.value = value
	} catch (cause) {
		if (ticket === generation)
			error.value = cause instanceof Error ? cause.message : 'Payload preview failed.'
	} finally {
		busy.value = false
	}
}
function example() {
	body.value = '{\n  "index": {{index}},\n  "job": "{{jobId}}",\n  "value": {{random}}\n}'
}
</script>
<template>
	<section aria-label="Test payload" class="payload-editor">
		<div class="generator-fields">
			<label
				>Payload<select v-model="kind" aria-label="Test payload generator">
					<option value="literal">Literal text</option>
					<option value="json-template">JSON template</option>
					<option value="binary">Seeded bytes</option>
				</select></label
			>
			<label v-if="kind !== 'literal'"
				>Seed<Input
					v-model.number="seed"
					aria-label="Test generator seed"
					type="number"
					min="0"
					max="2147483647"
			/></label>
			<label v-if="kind === 'binary'"
				>Bytes<Input
					v-model.number="size"
					aria-label="Test payload bytes"
					type="number"
					min="1"
					max="65536"
			/></label>
			<label v-if="kind === 'literal'"
				>Content type<Input
					v-model="contentType"
					aria-label="Test content type"
					maxlength="128"
			/></label>
		</div>
		<label v-if="kind !== 'binary'"
			>{{ kind === 'json-template' ? 'JSON template' : 'Message body'
			}}<textarea v-model="body" aria-label="Test message body" maxlength="65536" rows="4" />
		</label>
		<div v-if="kind === 'json-template'" class="template-help">
			<p class="explorer-note" v-pre>
				Tokens: {{ index }}, {{ jobId }}, {{ messageId }}, {{ seed }}, {{ random }}.
				Generated JSON is limited to 64 KiB.
			</p>
			<Button variant="outline" size="sm" @click="example">Use example</Button>
		</div>
		<p v-if="kind === 'binary'" class="explorer-note">
			Repeatable bytes from the seed and message index. Content type:
			application/octet-stream.
		</p>
		<Button variant="outline" size="sm" :disabled="busy" @click="showPreview">{{
			busy ? 'Preparing…' : 'Preview payload'
		}}</Button>
		<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
		<section v-if="preview" aria-label="Test payload preview">
			<p class="explorer-note">
				Sample 1 · {{ preview.byteLength }} bytes ·
				{{ preview.contentType || 'No content type' }}. Job IDs vary per run.
			</p>
			<pre>{{ previewText }}</pre>
			<p v-if="kind === 'binary' || preview.byteLength > 4096" class="explorer-note">
				{{ kind === 'binary' ? 'First 64 bytes.' : 'First 4 KiB.' }} Original generated
				bytes are sent.
			</p>
		</section>
	</section>
</template>
<style scoped>
.payload-editor {
	display: grid;
	gap: 0.65rem;
}
.generator-fields {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 1rem;
}
label {
	display: block;
}
select,
textarea {
	width: 100%;
	padding: 0.5rem;
	background: var(--background);
	color: var(--foreground);
	border: 1px solid var(--border);
	border-radius: 0.4rem;
}
textarea,
pre {
	font-family: monospace;
}
textarea {
	resize: vertical;
}
pre {
	max-height: 180px;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	background: var(--muted);
	padding: 0.75rem;
	border-radius: 0.4rem;
}
</style>
