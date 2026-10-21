<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import PropertyTable from '@/shared/components/PropertyTable.vue'
import { prettyJson, utf8Preview, hexPreview } from '@/shared/lib/message-body'
import { bodyFormats, useBodyFormat } from '@/shared/composables/use-body-format'
import { BodyCodecTools } from '@/features/body-tools'
import { useEventHubs } from '../stores/event-hubs'
import { useEventListener } from '../stores/event-hubs-listener'

const open = defineModel<boolean>('open', { required: true })
const eh = useEventHubs()
const listener = useEventListener()
const text = computed(() => utf8Preview(eh.body, eh.nextOffset === null))
const json = computed(() =>
	eh.bodyOffset === 0 && eh.nextOffset === null && text.value !== null
		? prettyJson(text.value)
		: null,
)
const { format, selectFormat } = useBodyFormat(() => eh.event?.summary.snapshotId, json)
const preview = computed(() =>
	format.value === 'hex'
		? hexPreview(eh.body, eh.bodyOffset)
		: format.value === 'json'
			? json.value
			: text.value,
)
</script>
<template>
	<Dialog v-model:open="open"
		><DialogContent class="message-inspection-dialog" movable resizable
			><DialogHeader
				><DialogTitle>Inspect event</DialogTitle
				><DialogDescription
					>Retained event bytes and metadata. This read does not delete the
					event.</DialogDescription
				></DialogHeader
			>
			<p v-if="eh.error" role="alert" class="error-banner">{{ eh.error }}</p>
			<template v-if="eh.event">
				<div class="explorer-actions">
					<Button
						variant="outline"
						:disabled="!!eh.busy || !eh.event.summary.snapshotId"
						@click="listener.exportEvents([eh.event.summary.snapshotId!])"
						>Export event…</Button
					><Button
						variant="outline"
						:disabled="!!eh.busy || !eh.event.summary.snapshotId"
						@click="listener.exportEvents([eh.event.summary.snapshotId!], 'body')"
						>Save event body…</Button
					>
				</div>
				<p v-if="listener.notice" role="status">{{ listener.notice }}</p>
				<p class="mono">
					Sequence {{ eh.event.summary.sequenceNumber }} · Offset
					{{ eh.event.summary.offset }}
				</p>
				<p class="explorer-note">
					Enqueued {{ eh.event.summary.enqueuedTime }} · Partition key
					{{ eh.event.summary.partitionKey ?? '—' }}
				</p>
				<dl class="eh-metadata">
					<div>
						<dt>Message ID</dt>
						<dd>{{ eh.event.messageId ?? '—' }}</dd>
					</div>
					<div>
						<dt>Content type</dt>
						<dd>{{ eh.event.contentType ?? '—' }}</dd>
					</div>
					<div>
						<dt>Correlation ID</dt>
						<dd>{{ eh.event.correlationId ?? '—' }}</dd>
					</div>
				</dl>
				<p v-if="eh.event.warning" class="inspector-warning">{{ eh.event.warning }}</p>
				<div class="explorer-actions">
					<Button
						v-for="item in bodyFormats"
						:key="item"
						variant="outline"
						size="sm"
						:aria-pressed="format === item"
						:disabled="item === 'json' && json === null"
						@click="selectFormat(item)"
						>{{ item.toUpperCase() }}</Button
					><span
						>Bytes {{ eh.bodyOffset }}–{{ eh.bodyOffset + eh.body.length }} of
						{{ eh.event.summary.bodySize }}</span
					>

					<BodyCodecTools
						:bytes="eh.body"
						:source-key="eh.event.summary.snapshotId ?? ''"
						:disabled="
							!!eh.busy ||
							!eh.event.summary.snapshotId ||
							eh.bodyOffset !== 0 ||
							eh.nextOffset !== null ||
							eh.body.length !== eh.event.summary.bodySize ||
							eh.body.length > 262144
						"
					/>
				</div>
				<p v-if="preview === null" class="inspector-warning">
					This range is not valid UTF-8. Choose HEX to inspect the bytes.
				</p>
				<pre v-else class="body-preview" data-testid="event-body">{{
					preview || '(Empty body)'
				}}</pre>
				<div class="explorer-actions">
					<Button
						v-if="eh.bodyOffset > 0"
						variant="outline"
						:disabled="!!eh.busy"
						@click="eh.readBody(Math.max(0, eh.bodyOffset - 65536))"
						>Previous event body range</Button
					><Button
						v-if="eh.nextOffset !== null"
						variant="outline"
						:disabled="!!eh.busy"
						@click="eh.readBody(eh.nextOffset!)"
						>Next event body range</Button
					>
				</div>
				<p v-if="eh.bodyOffset || eh.nextOffset !== null" class="explorer-note">
					Partial body range. UTF-8 characters may cross range boundaries; JSON formatting
					requires the complete body.
				</p>
				<h4>Application properties</h4>
				<PropertyTable :properties="eh.event.applicationProperties" />
				<h4>System properties</h4>
				<PropertyTable :properties="eh.event.systemProperties" />
			</template> </DialogContent
	></Dialog>
</template>
<style scoped>
.eh-metadata {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 0.5rem;
	margin: 0.6rem 0;
}
.eh-metadata dt {
	color: var(--muted-foreground);
	font-size: 0.85rem;
}
.eh-metadata dd {
	margin: 0;
	overflow-wrap: anywhere;
}
</style>
