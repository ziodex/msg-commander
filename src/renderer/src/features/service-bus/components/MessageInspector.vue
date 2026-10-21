<script setup lang="ts">
import { computed } from 'vue'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { hexPreview, prettyJson, utf8Preview } from '@/shared/lib/message-body'
import { Button } from '@/shared/ui/button'
import MessageInspectorActions from './MessageInspectorActions.vue'
import { BodyCodecTools } from '@/features/body-tools'
import { bodyFormats, useBodyFormat } from '@/shared/composables/use-body-format'
import type { EntityTarget, MessageSubQueue } from '@shared/service-bus'
const props = defineProps<{
	source?: EntityTarget
	subQueue?: MessageSubQueue
	canReceive?: boolean
	requiresSession?: boolean
}>()
import JsonBody from '../../../shared/components/JsonBody.vue'
import PropertyTable from '../../../shared/components/PropertyTable.vue'
const sb = useServiceBus()
const complete = computed(() => sb.bodyStart === 0 && sb.nextBodyOffset === null)
const text = computed(() => utf8Preview(sb.body, sb.nextBodyOffset === null))
const json = computed(() => (complete.value && text.value !== null ? prettyJson(text.value) : null))
const { format, selectFormat } = useBodyFormat(() => sb.message?.summary.snapshotId, json)
const preview = computed(() =>
	format.value === 'hex'
		? hexPreview(sb.body, sb.bodyStart)
		: format.value === 'json'
			? json.value
			: text.value,
)
const deadLetter = computed(() =>
	sb.message?.systemProperties.filter(
		(p) =>
			(p.name === 'DeadLetterReason' || p.name === 'DeadLetterErrorDescription') &&
			p.type !== 'null',
	),
)
</script>
<template>
	<section v-if="sb.message" class="message-inspector" aria-label="Message inspector">
		<div class="explorer-heading">
			<div class="message-identity">
				<span class="message-label-caption">Label (subject)</span>
				<h3 class="message-label-title">
					{{
						sb.message.summary.subject?.trim() ? sb.message.summary.subject : 'No label'
					}}
				</h3>
				<p class="message-identity-meta">
					<span>{{ sb.message.summary.messageId ?? '(No message ID)' }}</span>
					<span>#{{ sb.message.summary.sequenceNumber }}</span>
				</p>
			</div>
			<div class="explorer-actions">
				<Button
					size="sm"
					variant="outline"
					:disabled="!!sb.busy || !sb.message.summary.snapshotId"
					@click="sb.exportMessages([sb.message.summary])"
					>Save message</Button
				><Button
					size="sm"
					variant="outline"
					:disabled="!!sb.busy || !sb.message.summary.snapshotId"
					@click="sb.exportMessages([sb.message.summary], 'body')"
					>Save body to file</Button
				>
			</div>
		</div>
		<MessageInspectorActions
			v-if="props.source"
			:key="sb.message.summary.snapshotId ?? sb.message.summary.sequenceNumber"
			:source="props.source"
			:sub-queue="props.subQueue ?? 'active'"
			:summary="sb.message.summary"
			:can-receive="props.canReceive"
			:requires-session="props.requiresSession"
		/>
		<p v-if="sb.error" class="error-banner" role="alert">{{ sb.error }}</p>
		<p v-if="sb.fileNotice" role="status" class="explorer-note">{{ sb.fileNotice }}</p>
		<div v-if="deadLetter?.length" class="inspector-warning">
			<p v-for="property in deadLetter" :key="property.name">
				<strong>{{ property.name }}:</strong> {{ property.value }}
			</p>
		</div>
		<div class="explorer-actions">
			<h4>Body</h4>

			<BodyCodecTools
				:bytes="sb.body"
				:source-key="sb.message.summary.snapshotId ?? ''"
				:disabled="
					!!sb.busy ||
					!sb.message.summary.snapshotId ||
					!complete ||
					sb.body.length !== sb.message.summary.bodySize ||
					sb.body.length > 262144
				"
			/>
			<div class="explorer-tabs" role="group" aria-label="Body format">
				<button
					v-for="item in bodyFormats"
					:key="item"
					:aria-pressed="format === item"
					:disabled="item === 'json' && json === null"
					@click="selectFormat(item)"
				>
					{{ item.toUpperCase() }}
				</button>
			</div>
			<span class="explorer-note"
				>Bytes {{ sb.bodyStart }}–{{ sb.bodyStart + sb.body.length }} of
				{{ sb.message.summary.bodySize }}</span
			>
		</div>
		<p v-if="sb.bodyStart || sb.nextBodyOffset !== null" class="explorer-note">
			Partial body. UTF-8 characters spanning a range boundary may require viewing the
			preceding range. JSON formatting requires the complete body.
		</p>
		<p v-if="preview === null" class="inspector-warning">
			This range is not valid UTF-8. Select HEX to inspect the original bytes.
		</p>
		<JsonBody
			v-else-if="format === 'json' && json !== null"
			:text="json"
			data-testid="message-body"
		/>
		<pre v-else class="body-preview" data-testid="message-body">{{
			preview || (sb.message.summary.bodySize ? '(No bytes loaded)' : '(Empty body)')
		}}</pre>
		<div v-if="sb.bodyStart || sb.nextBodyOffset !== null" class="explorer-actions">
			<Button
				variant="outline"
				size="sm"
				:disabled="!!sb.busy || sb.bodyStart === 0"
				@click="sb.bodyWindow(Math.max(0, sb.bodyStart - 262144))"
				>Previous body range</Button
			>
			<Button
				v-if="sb.nextBodyOffset !== null && sb.body.length < 262144"
				variant="outline"
				size="sm"
				:disabled="!!sb.busy"
				@click="sb.readBody()"
				>Load more bytes</Button
			>
			<Button
				v-if="sb.nextBodyOffset !== null && sb.body.length >= 262144"
				variant="outline"
				size="sm"
				:disabled="!!sb.busy"
				@click="sb.bodyWindow(sb.nextBodyOffset!)"
				>Next body range</Button
			>
		</div>
		<details open>
			<summary>
				Application properties ({{ sb.message.applicationProperties.length }})
			</summary>
			<PropertyTable :properties="sb.message.applicationProperties" />
		</details>
		<details>
			<summary>System properties</summary>
			<PropertyTable :properties="sb.message.systemProperties" />
		</details>
	</section>
</template>
