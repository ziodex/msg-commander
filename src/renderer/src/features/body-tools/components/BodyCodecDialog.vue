<script setup lang="ts">
import { bodyToolsApi } from '@/features/body-tools/api'

import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import { composerBody } from '@/shared/lib/composer'
import { decodeBase64, hexPreview, utf8Preview } from '@/shared/lib/message-body'
import { useWorkspace } from '@/shared/workspace/store'
import { codecFormats, type CodecOptions, type CodecResult } from '@shared/body-codecs'
const props = defineProps<{
	open: boolean
	initialBase64?: string
	sourceKey?: string
	allowApply?: boolean
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; apply: [base64: string] }>()
const workspace = useWorkspace()
const options = reactive<CodecOptions>({
	direction: 'decode',
	format: 'text',
	encoding: 'utf8',
	compression: 'none',
	bom: false,
})
const input = ref(''),
	representation = ref<'text' | 'base64'>('text'),
	busy = ref(false),
	error = ref(''),
	notice = ref(''),
	result = ref<CodecResult>(),
	view = ref('text')
let generation = 0,
	pending: string | undefined
function discard(id: string) {
	void bodyToolsApi.discardCodecBody(id).catch(() => {})
}
function invalidate() {
	generation++
	if (pending) void bodyToolsApi.cancelOperation(pending).catch(() => {})
	if (result.value) discard(result.value.resultId)
	result.value = undefined
	error.value = ''
	notice.value = ''
}
watch([options, input, representation], invalidate, { deep: true, flush: 'sync' })
watch(
	() => props.open,
	(open) => {
		invalidate()
		if (open) {
			representation.value = props.initialBase64 === undefined ? 'text' : 'base64'
			input.value = props.initialBase64 ?? ''
			view.value = 'text'
		}
	},
)
watch(
	() => props.sourceKey,
	() => {
		if (props.open) {
			invalidate()
			emit('update:open', false)
		}
	},
)
onBeforeUnmount(invalidate)
const bytes = computed(() =>
	result.value ? decodeBase64(result.value.contentBase64) : new Uint8Array(),
)
const preview = computed(() =>
	view.value === 'base64'
		? result.value?.contentBase64.slice(0, 65536)
		: view.value === 'hex'
			? hexPreview(bytes.value.subarray(0, 65536))
			: utf8Preview(bytes.value.subarray(0, 65536), bytes.value.length <= 65536),
)
async function convert() {
	invalidate()
	busy.value = true
	const ticket = generation,
		id = crypto.randomUUID()
	pending = id
	try {
		const source = composerBody(
			input.value,
			representation.value === 'text' ? 'text' : 'base64',
		)
		const value = workspace.unwrapResult(
			await bodyToolsApi.convertBody({ id, ...options, contentBase64: source.base64 }),
		)
		if (ticket !== generation) {
			discard(value.resultId)
			return
		}
		result.value = value
		view.value = value.kind === 'bytes' ? 'hex' : 'text'
	} catch (cause) {
		if (ticket === generation)
			error.value = cause instanceof Error ? cause.message : 'Body conversion failed.'
	} finally {
		if (pending === id) pending = undefined
		busy.value = false
	}
}
async function openFile() {
	invalidate()
	busy.value = true
	const ticket = generation,
		id = crypto.randomUUID()
	pending = id
	try {
		const file = workspace.unwrapResult(await bodyToolsApi.openCodecBody({ id }))
		if (ticket !== generation) return
		if (file.cancelled) {
			notice.value = 'File selection cancelled.'
			return
		}
		representation.value = 'base64'
		input.value = file.contentBase64!
		notice.value = `Loaded ${file.fileName}. Opening a file leaves it unchanged.`
	} catch (cause) {
		if (ticket === generation)
			error.value = cause instanceof Error ? cause.message : 'Body file could not be opened.'
	} finally {
		if (pending === id) pending = undefined
		busy.value = false
	}
}
async function save() {
	if (!result.value) return
	busy.value = true
	const id = crypto.randomUUID()
	pending = id
	try {
		const file = workspace.unwrapResult(
			await bodyToolsApi.saveCodecBody({ id, resultId: result.value.resultId }),
		)
		notice.value = file.cancelled
			? 'Save cancelled.'
			: `Saved converted body to ${file.fileName}.`
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Body could not be saved.'
	} finally {
		if (pending === id) pending = undefined
		busy.value = false
	}
}
function apply() {
	if (result.value) {
		emit('apply', result.value.contentBase64)
		emit('update:open', false)
	}
}
</script>
<template>
	<Dialog :open="open" @update:open="emit('update:open', $event)"
		><DialogContent class="max-h-[88dvh] overflow-y-auto sm:max-w-[900px]">
			<DialogHeader
				><DialogTitle>Body tools</DialogTitle
				><DialogDescription
					>Convert a copy of the body. Review the format and output before saving or using
					it in a draft. Maximum 256 KiB at every stage.</DialogDescription
				></DialogHeader
			>
			<div class="codec-options">
				<label
					>Operation<select
						class="commander-select"
						v-model="options.direction"
						aria-label="Codec operation"
						:disabled="busy"
					>
						<option value="decode">Decode bytes</option>
						<option value="encode">Encode a body</option>
					</select></label
				>
				<label
					>Body format<select
						class="commander-select"
						v-model="options.format"
						aria-label="Codec body format"
						:disabled="busy"
					>
						<option v-for="(name, key) in codecFormats" :key="key" :value="key">
							{{ name }}
						</option>
					</select></label
				>
				<label
					>Compression<select
						class="commander-select"
						v-model="options.compression"
						aria-label="Codec compression"
						:disabled="busy"
					>
						<option value="none">None</option>
						<option value="gzip">GZip</option>
						<option value="deflate">Raw Deflate</option>
					</select></label
				>
				<label
					>Text encoding<select
						class="commander-select"
						v-model="options.encoding"
						aria-label="Codec text encoding"
						:disabled="busy || options.format !== 'text'"
					>
						<option value="utf8">UTF-8</option>
						<option value="ascii">ASCII (strict)</option>
						<option value="utf16le">UTF-16 little endian (Unicode)</option>
						<option value="utf16be">UTF-16 big endian</option>
						<option value="utf32le">UTF-32 little endian</option>
						<option value="utf32be">UTF-32 big endian</option>
					</select></label
				>
				<label class="codec-check"
					><input
						v-model="options.bom"
						type="checkbox"
						:disabled="
							busy ||
							options.direction !== 'encode' ||
							options.format !== 'text' ||
							options.encoding === 'ascii'
						"
					/>Include a byte-order mark when encoding text</label
				>
			</div>
			<p class="explorer-note">
				Text encoding takes UTF-8 source bytes; decoding returns UTF-8. Compression
				preserves arbitrary bytes.
			</p>
			<div class="explorer-actions codec-source-row">
				<label class="codec-source"
					>Source representation<select
						class="commander-select"
						v-model="representation"
						aria-label="Codec source representation"
						:disabled="busy"
					>
						<option value="text">UTF-8 text</option>
						<option value="base64">Original bytes (base64)</option>
					</select></label
				><Button variant="outline" :disabled="busy" @click="openFile"
					>Open body file…</Button
				>
			</div>
			<label class="codec-input"
				>Source body<textarea
					v-model="input"
					aria-label="Codec source body"
					rows="5"
					maxlength="349528"
					:disabled="busy"
					class="mono commander-textarea"
				/>
			</label>
			<Button :disabled="busy" @click="convert">{{
				busy ? 'Working…' : 'Convert body'
			}}</Button>
			<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
			<p v-if="notice" role="status" class="explorer-note">{{ notice }}</p>
			<section v-if="result" aria-label="Converted body review">
				<div class="explorer-actions">
					<strong>Converted body · {{ result.byteLength }} bytes</strong
					><Button
						v-for="item in ['text', 'hex', 'base64']"
						:key="item"
						variant="outline"
						size="sm"
						:disabled="item === 'text' && result.kind === 'bytes'"
						:aria-pressed="view === item"
						@click="view = item"
						>{{ item.toUpperCase() }}</Button
					>
				</div>
				<p class="codec-digest mono">SHA-256 {{ result.sha256 }}</p>
				<pre class="body-preview codec-preview" data-testid="codec-output">{{
					preview === null
						? 'Select HEX to inspect these bytes.'
						: preview || '(Empty body)'
				}}</pre>
				<p v-if="bytes.length > 65536" class="explorer-note">
					The preview is limited to 64 KiB. Saving or using this result includes all
					converted bytes.
				</p>
				<ul v-if="result.warnings.length" class="codec-warnings">
					<li v-for="(warning, index) in result.warnings" :key="index">{{ warning }}</li>
				</ul>
				<div class="explorer-actions">
					<Button variant="outline" :disabled="busy" @click="save"
						>Save converted body…</Button
					><Button v-if="allowApply" :disabled="busy" @click="apply"
						>Use converted body in draft</Button
					>
				</div>
			</section>
			<div class="dialog-actions">
				<Button variant="outline" @click="emit('update:open', false)"
					>Close body codecs</Button
				>
			</div>
		</DialogContent></Dialog
	>
</template>
<style scoped>
.codec-options {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 12px;
}
.codec-options label,
.codec-input,
.codec-source {
	display: grid;
	gap: 8px;
	font-size: 12px;
	color: var(--muted-foreground);
}
.codec-options select:disabled {
	opacity: 0.55;
}
.codec-source-row {
	align-items: flex-end;
}
.codec-source {
	flex: 1 1 240px;
	min-width: 0;
}
.codec-options .codec-check {
	display: flex;
	align-items: center;
	gap: 8px;
	grid-column: 1/-1;
}
.codec-preview {
	max-height: 280px;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.codec-digest {
	font-size: 11px;
	overflow-wrap: anywhere;
	margin: 8px 0;
	color: var(--muted-foreground);
}
.codec-warnings {
	list-style: disc;
	padding-left: 20px;
	font-size: 13px;
	color: var(--muted-foreground);
}
@media (max-width: 600px) {
	.codec-options {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
