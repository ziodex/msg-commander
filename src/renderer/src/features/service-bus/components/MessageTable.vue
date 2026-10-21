<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import { ArrowDown, ArrowUp } from '@lucide/vue'
import type { MessageSummary } from '@shared/service-bus'

const props = defineProps<{
	messages: MessageSummary[]
	selectedSnapshot?: string | null
	disabled?: boolean
}>()
const emit = defineEmits<{ inspect: [message: MessageSummary]; copy: []; export: [] }>()
const selection = defineModel<string[]>('selection', { default: () => [] })
const selectable = computed(() =>
	props.messages.flatMap((message) => (message.snapshotId ? [message.snapshotId] : [])),
)
const allSelected = computed(
	() =>
		selectable.value.length > 0 && selectable.value.every((id) => selection.value.includes(id)),
)
watch(
	selectable,
	(ids) => {
		selection.value = selection.value.filter((id) => ids.includes(id))
	},
	{ immediate: true },
)
function selectAll() {
	selection.value = allSelected.value ? [] : [...selectable.value]
}
function toggleSelection(id: string) {
	selection.value = selection.value.includes(id)
		? selection.value.filter((value) => value !== id)
		: [...selection.value, id]
}
function navigate(event: KeyboardEvent) {
	if (props.disabled) return
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
		event.preventDefault()
		selection.value = [...selectable.value]
	} else if (
		(event.ctrlKey || event.metaKey) &&
		event.key.toLowerCase() === 'c' &&
		selection.value.length &&
		!window.getSelection()?.toString()
	) {
		event.preventDefault()
		emit('copy')
	} else if (
		(event.ctrlKey || event.metaKey) &&
		event.shiftKey &&
		event.key.toLowerCase() === 'e' &&
		selection.value.length
	) {
		event.preventDefault()
		emit('export')
	} else if (event.key === 'Escape' && selection.value.length) {
		event.preventDefault()
		selection.value = []
	} else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
		const row = (event.target as HTMLElement).closest('tbody tr')
		if (!row) return
		const buttons = [
			...row.parentElement!.querySelectorAll<HTMLButtonElement>(
				'[data-message-open]:not(:disabled)',
			),
		]
		const index = buttons.findIndex((button) => button.closest('tr') === row)
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? buttons.length - 1
					: Math.max(
							0,
							Math.min(
								buttons.length - 1,
								index + (event.key === 'ArrowDown' ? 1 : -1),
							),
						)
		event.preventDefault()
		buttons[next]?.focus()
	}
}
const columns = [
	{ key: 'subject', label: 'Label (subject)', width: 260, minimum: 80 },
	{ key: 'sequenceNumber', label: 'Sequence / message ID', width: 200, minimum: 130 },
	{ key: 'state', label: 'State', width: 90, minimum: 70 },
	{ key: 'bodySize', label: 'Bytes', width: 65, minimum: 55 },
	{ key: 'enqueuedTime', label: 'Enqueued (UTC)', width: 245, minimum: 140 },
] as const
const storageKey = 'commander-message-column-widths-v2'
function savedWidths(): number[] {
	try {
		let saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
		if (saved === null) {
			const previous = JSON.parse(
				localStorage.getItem('commander-message-column-widths-v1') ?? 'null',
			)
			if (Array.isArray(previous) && previous.length === columns.length)
				saved = [previous[1], previous[0], ...previous.slice(2)]
		}
		if (
			Array.isArray(saved) &&
			saved.length === columns.length &&
			saved.every(
				(value, index) =>
					Number.isFinite(value) && value >= columns[index]!.minimum && value <= 1200,
			)
		)
			return saved
	} catch {
		// Optional layout preference.
	}
	return columns.map((column) => column.width)
}
const widths = ref(savedWidths())
const layout = useWorkspaceLayout()
watch(
	() => layout.resetVersion,
	() => {
		widths.value = columns.map((column) => column.width)
	},
)
watch(
	widths,
	(value) => {
		try {
			localStorage.setItem(storageKey, JSON.stringify(value))
		} catch {
			// Optional layout preference.
		}
	},
	{ deep: true },
)
const sort = ref<{ key: (typeof columns)[number]['key']; direction: 1 | -1 }>()
function toggleSort(key: (typeof columns)[number]['key']) {
	sort.value =
		sort.value?.key !== key
			? { key, direction: 1 }
			: sort.value.direction === 1
				? { key, direction: -1 }
				: undefined
}
const rows = computed(() => {
	const order = sort.value
	if (!order) return props.messages
	return [...props.messages].sort((a, b) => {
		let result: number
		if (order.key === 'sequenceNumber') {
			const left = BigInt(a.sequenceNumber),
				right = BigInt(b.sequenceNumber)
			result = left < right ? -1 : left > right ? 1 : 0
		} else if (order.key === 'bodySize') result = a.bodySize - b.bodySize
		else if (order.key === 'enqueuedTime')
			result = Date.parse(a.enqueuedTime) - Date.parse(b.enqueuedTime)
		else result = (a[order.key] ?? '').localeCompare(b[order.key] ?? '')
		return result * order.direction
	})
})
let drag: { index: number; x: number; width: number; pointerId: number } | undefined
function resize(index: number, value: number) {
	widths.value[index] = Math.round(Math.max(columns[index]!.minimum, Math.min(1200, value)))
}
function startResize(event: PointerEvent, index: number) {
	if (event.button !== 0) return
	const handle = event.currentTarget as HTMLElement
	const headers = handle.closest('tr')!.querySelectorAll('th:not(.message-selection)')
	widths.value = [...headers].map((header) => header.getBoundingClientRect().width)
	drag = { index, x: event.clientX, width: widths.value[index]!, pointerId: event.pointerId }
	handle.setPointerCapture(event.pointerId)
	event.preventDefault()
}
function moveResize(event: PointerEvent) {
	if (drag && drag.pointerId === event.pointerId)
		resize(drag.index, drag.width + event.clientX - drag.x)
}
function endResize(event: PointerEvent) {
	if (drag?.pointerId !== event.pointerId) return
	drag = undefined
	const handle = event.currentTarget as HTMLElement
	if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}
function keyboardResize(event: KeyboardEvent, index: number) {
	const width = (event.currentTarget as HTMLElement).closest('th')!.getBoundingClientRect().width
	if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
		resize(index, width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 25 : 10))
	} else if (event.key === 'Home') resize(index, columns[index]!.minimum)
	else if (event.key === 'End') resize(index, columns[index]!.width)
	else return
	event.preventDefault()
}
</script>

<template>
	<table
		class="message-table resizable-message-table"
		aria-label="Messages"
		@keydown="navigate"
		:style="{ minWidth: widths.reduce((sum, width) => sum + width, 36) + 'px' }"
	>
		<caption v-if="sort">
			Sorted within this page
		</caption>
		<colgroup>
			<col style="width: 36px" />
			<col
				v-for="(column, index) in columns"
				:key="column.key"
				:style="{ width: widths[index] + 'px' }"
			/>
		</colgroup>
		<thead>
			<tr>
				<th class="message-selection">
					<input
						type="checkbox"
						aria-label="Select all messages on this page"
						:checked="allSelected"
						:indeterminate="selection.length > 0 && !allSelected"
						:disabled="disabled || !selectable.length"
						@change="selectAll"
					/>
				</th>
				<th
					v-for="(column, index) in columns"
					:key="column.key"
					scope="col"
					:aria-sort="
						sort?.key === column.key
							? sort.direction === 1
								? 'ascending'
								: 'descending'
							: 'none'
					"
				>
					<button
						class="column-sort"
						:aria-label="'Sort loaded messages by ' + column.label"
						:title="'Sort loaded messages by ' + column.label"
						@click="toggleSort(column.key)"
					>
						{{ column.label
						}}<component
							v-if="sort?.key === column.key"
							:is="sort.direction === 1 ? ArrowUp : ArrowDown"
							:size="12"
						/>
					</button>
					<span
						class="column-resize-handle"
						role="separator"
						tabindex="0"
						aria-orientation="vertical"
						:aria-label="'Resize ' + column.label + ' column'"
						:aria-valuemin="column.minimum"
						:aria-valuemax="1200"
						:aria-valuenow="Math.round(widths[index]!)"
						title="Drag to resize · Arrow keys to adjust"
						@pointerdown="startResize($event, index)"
						@pointermove="moveResize"
						@pointerup="endResize"
						@pointercancel="endResize"
						@lostpointercapture="drag = undefined"
						@keydown="keyboardResize($event, index)"
						@dblclick="resize(index, column.width)"
					/>
				</th>
			</tr>
		</thead>
		<tbody>
			<tr
				v-for="message in rows"
				:key="message.sequenceNumber"
				:class="{
					selected:
						!!message.snapshotId &&
						(selectedSnapshot === message.snapshotId ||
							selection.includes(message.snapshotId)),
				}"
			>
				<td class="message-selection">
					<input
						type="checkbox"
						:aria-label="
							'Select message ' + (message.messageId ?? message.sequenceNumber)
						"
						:checked="!!message.snapshotId && selection.includes(message.snapshotId)"
						:disabled="disabled || !message.snapshotId"
						@change="message.snapshotId && toggleSelection(message.snapshotId)"
					/>
				</td>
				<td class="message-label-cell">
					<strong v-if="message.subject?.trim()" class="message-label-text">{{
						message.subject
					}}</strong>
					<span v-else class="message-label-empty">No label</span>
				</td>
				<td>
					<button
						data-message-open
						:disabled="disabled || !message.snapshotId"
						@click="$emit('inspect', message)"
					>
						<strong class="mono">{{ message.sequenceNumber }}</strong
						><span>{{ message.messageId ?? '(No message ID)' }}</span>
					</button>
					<p v-if="message.inspectionWarning" class="inspector-warning">
						{{ message.inspectionWarning }}
					</p>
				</td>
				<td>
					{{ message.state
					}}<small v-if="message.sessionId">Session: {{ message.sessionId }}</small>
				</td>
				<td>{{ message.bodySize }}</td>
				<td>{{ message.enqueuedTime }}</td>
			</tr>
		</tbody>
	</table>
</template>
