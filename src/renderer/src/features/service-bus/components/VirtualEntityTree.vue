<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ChevronDown, ChevronRight, Folder, Mail, MailWarning } from '@lucide/vue'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import { useWorkspace } from '@/shared/workspace/store'
import { flattenEntityTree, type TreeRow } from '@/features/service-bus/lib/virtual-tree'
import { useVirtualRows } from '@/shared/composables/use-virtual-rows'
import { entityKey, countText } from '@/features/service-bus/lib/entity-counts'
import { entityPath } from '@shared/entity-management'
import { subQueueLabel } from '@shared/service-bus'
import type { TreeAction } from '@/features/service-bus/lib/tree-actions'
import EntityTreeRow from './EntityTreeRow.vue'
import EntityContextMenu from './EntityContextMenu.vue'
const emit = defineEmits<{ action: [action: TreeAction] }>()
const tree = useEntityTree(),
	sb = useServiceBus(),
	monitor = useNamespaceMonitor(),
	workspace = useWorkspace()
const root = ref<HTMLElement>()
const rows = computed(() => flattenEntityTree(tree.branches, tree.expanded, tree.filter))
const { visible, before, after, onScroll: updateScroll, scrollTo } = useVirtualRows(rows, root)
const focusedKey = ref('')
function rememberFocus(event: FocusEvent) {
	const index = Number(
		(event.target as HTMLElement).closest<HTMLElement>('[data-virtual-index]')?.dataset
			.virtualIndex ?? -1,
	)
	focusedKey.value = rows.value[index]?.key ?? focusedKey.value
}
function onScroll() {
	updateScroll()
	if (
		root.value?.contains(document.activeElement) &&
		document.activeElement !== root.value &&
		!visible.value.some((item) => item.row.key === focusedKey.value)
	)
		root.value.focus({ preventScroll: true })
}
function toggle(row: TreeRow) {
	if (row.type === 'group') tree.expanded[row.kind] = !row.expanded
	else if (row.type === 'folder') tree.expanded[row.key] = !row.expanded
	else if (row.type === 'entity') void tree.toggle(row.entity)
}
async function focusRow(index: number) {
	index = Math.max(0, Math.min(rows.value.length - 1, index))
	scrollTo(index)
	await nextTick()
	const row = root.value?.querySelector<HTMLElement>(`[data-virtual-index="${index}"]`)
	const primary = row?.querySelector<HTMLButtonElement>(
		'.tree-entity:not(:disabled), .tree-leaf:not(:disabled), .tree-group',
	)
	;(primary ?? row?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
}
function keyboard(event: KeyboardEvent) {
	const index = Number(
		(event.target as HTMLElement).closest<HTMLElement>('[data-virtual-index]')?.dataset
			.virtualIndex ??
			Math.max(
				0,
				rows.value.findIndex((row) => row.key === focusedKey.value),
			),
	)
	const row = rows.value[index]
	if (!row || (event.target as HTMLElement).tagName === 'INPUT') return
	if (event.key === 'ArrowDown') void focusRow(index + 1)
	else if (event.key === 'ArrowUp') void focusRow(index - 1)
	else if (event.key === 'Home') void focusRow(0)
	else if (event.key === 'End') void focusRow(rows.value.length - 1)
	else if (event.key === 'ArrowRight') {
		if (
			((row.type === 'group' || row.type === 'folder') && !row.expanded) ||
			(row.type === 'entity' && !tree.expanded[row.key])
		)
			toggle(row)
		else void focusRow(index + 1)
	} else if (event.key === 'ArrowLeft') {
		if (
			((row.type === 'group' || row.type === 'folder') && row.expanded) ||
			(row.type === 'entity' && tree.expanded[row.key])
		)
			toggle(row)
		else if (row.parent) void focusRow(rows.value.findIndex((item) => item.key === row.parent))
	} else return
	event.preventDefault()
}
function selected(row: TreeRow) {
	return (
		row.type === 'leaf' &&
		!!sb.selected &&
		entityKey(sb.selected.target) === entityKey(row.entity.target) &&
		sb.subQueue === row.subQueue &&
		!!sb.messages
	)
}
function leafCount(row: TreeRow) {
	if (row.type !== 'leaf' || !workspace.preferences.showMessageCounts) return undefined
	const counts = monitor.counts(row.entity.target)
	return row.subQueue === 'active'
		? counts?.active
		: row.subQueue === 'dead-letter'
			? counts?.deadLetter
			: counts?.transferDeadLetter
}
</script>
<template>
	<ul
		ref="root"
		role="tree"
		aria-label="Namespace entities"
		class="entity-tree-list virtual-entity-tree"
		tabindex="0"
		@scroll="onScroll"
		@focusin="rememberFocus"
		@keydown="keyboard"
	>
		<li role="none" aria-hidden="true" :style="{ height: before + 'px' }" />
		<template v-for="{ row, index } in visible" :key="row.key">
			<EntityTreeRow
				v-if="row.type === 'entity'"
				:entity="row.entity"
				:flat="true"
				:aria-level="row.level"
				:aria-posinset="row.position"
				:aria-setsize="row.setSize"
				:data-virtual-index="index"
				:style="{ height: row.height + 'px', paddingLeft: (row.level - 1) * 14 + 'px' }"
				@action="emit('action', $event)"
			/>
			<li
				v-else
				:data-virtual-index="index"
				:role="row.type === 'hint' || row.type === 'more' ? 'none' : 'treeitem'"
				:aria-level="row.level"
				:aria-posinset="row.position"
				:aria-setsize="row.setSize"
				:aria-expanded="
					row.type === 'group' || row.type === 'folder' ? row.expanded : undefined
				"
				:aria-selected="row.type === 'leaf' ? selected(row) : undefined"
				:style="{ height: row.height + 'px', paddingLeft: (row.level - 1) * 14 + 'px' }"
			>
				<EntityContextMenu
					v-if="row.type === 'group'"
					:context="{ kind: row.kind }"
					@action="emit('action', $event)"
					><div class="tree-group-row">
						<button
							class="tree-toggle"
							:aria-label="`${row.expanded ? 'Collapse' : 'Expand'} ${row.kind === 'queue' ? 'queues' : 'topics'}`"
							:aria-expanded="row.expanded"
							@click="toggle(row)"
						>
							<component
								:is="row.expanded ? ChevronDown : ChevronRight"
								:size="14"
							/></button
						><button class="tree-group" @click="tree.expanded[row.kind] = true">
							{{ row.kind === 'queue' ? 'Queues' : 'Topics' }}
						</button>
						<small class="tree-group-count"
							>{{ row.count }}{{ row.more ? '+' : '' }}</small
						>
					</div></EntityContextMenu
				>
				<div v-else-if="row.type === 'folder'" class="tree-group-row">
					<button
						class="tree-toggle"
						:aria-expanded="row.expanded"
						:aria-label="'Toggle folder ' + row.prefix"
						@click="toggle(row)"
					>
						<component
							:is="row.expanded ? ChevronDown : ChevronRight"
							:size="13"
						/></button
					><Folder :size="13" /><span class="tree-folder-name">{{
						row.prefix.split('/').at(-1)
					}}</span
					><button
						v-if="tree.selectionMode"
						class="tree-folder-select"
						:disabled="!!sb.busy || tree.selectionBusy"
						:aria-label="`Select entire ${row.kind} folder ${row.prefix}`"
						@click="tree.selectScope(row.kind, row.prefix)"
					>
						Select folder
					</button>
				</div>
				<EntityContextMenu
					v-else-if="row.type === 'leaf'"
					:context="{ entity: row.entity, subQueue: row.subQueue }"
					@action="emit('action', $event)"
					><div class="tree-row" :class="{ selected: selected(row) }">
						<button
							class="tree-leaf"
							:class="{ selected: selected(row) }"
							:disabled="!!sb.busy"
							:aria-label="
								entityPath(row.entity.target) + ' ' + subQueueLabel(row.subQueue)
							"
							@click="tree.select(row.entity, row.subQueue)"
						>
							<component
								:is="row.subQueue === 'active' ? Mail : MailWarning"
								:size="13"
							/><span>{{ subQueueLabel(row.subQueue) }}</span></button
						><span
							class="tree-badge"
							:class="{ 'tree-dlq': row.subQueue !== 'active' }"
							>{{ countText(leafCount(row)) }}</span
						>
					</div></EntityContextMenu
				>
				<button
					v-else-if="row.type === 'more'"
					class="tree-more"
					:disabled="row.loading"
					@click="tree.load(row.kind, row.topic, true)"
				>
					Load more {{ row.kind === 'subscription' ? 'subscriptions' : row.kind + 's' }}
				</button>
				<span v-else class="tree-hint" :role="row.error ? 'alert' : undefined"
					>{{ row.text
					}}<button v-if="row.error" @click="tree.load(row.kind, row.topic)">
						Retry
					</button></span
				>
			</li>
		</template>
		<li role="none" aria-hidden="true" :style="{ height: after + 'px' }" />
	</ul>
</template>
