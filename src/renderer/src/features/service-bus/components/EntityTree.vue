<script setup lang="ts">
import { computed, onMounted } from 'vue'
import VirtualEntityTree from './VirtualEntityTree.vue'
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	RefreshCw,
	Search,
} from '@lucide/vue'
import { Input } from '@/shared/ui/input'
import { Button } from '@/shared/ui/button'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import EntityTreeBranch from './EntityTreeBranch.vue'
import EntityContextMenu from './EntityContextMenu.vue'
import type { TreeAction } from '@/features/service-bus/lib/tree-actions'
const emit = defineEmits<{ action: [action: TreeAction] }>()
const tree = useEntityTree(),
	sb = useServiceBus()
const virtualized = computed(
	() =>
		Object.values(tree.branches).reduce((count, branch) => count + branch.items.length, 0) >
		200,
)
onMounted(() => {
	if (!tree.branch('queue').loaded) void tree.load('queue')
	if (!tree.branch('topic').loaded) void tree.load('topic')
})
function group(kind: 'queue' | 'topic') {
	tree.expanded[kind] = true
	sb.category = kind
	sb.topicName = undefined
	if (!tree.branch(kind).loaded) void tree.load(kind)
}
function keyboard(event: KeyboardEvent) {
	if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key))
		return
	const root = event.currentTarget as HTMLElement,
		target = event.target as HTMLElement
	if (target.tagName !== 'BUTTON') return
	const buttons = [...root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(
		(button) => button.offsetParent !== null,
	)
	const index = buttons.indexOf(target as HTMLButtonElement)
	if (index < 0) return
	if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
		const row = target.closest('[role=treeitem]')
		const toggle = row?.querySelector<HTMLButtonElement>(
			':scope > .tree-row > .tree-toggle, :scope > .tree-group-row > .tree-toggle',
		)
		if (
			toggle &&
			toggle.getAttribute('aria-expanded') === (event.key === 'ArrowRight' ? 'false' : 'true')
		)
			toggle.click()
		else if (event.key === 'ArrowLeft')
			row?.parentElement
				?.closest('[role=treeitem]')
				?.querySelector<HTMLButtonElement>('button')
				?.focus()
	} else
		buttons[
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
		]?.focus()
	event.preventDefault()
}
</script>
<template>
	<aside class="entity-browser entity-tree" aria-label="Entities">
		<div class="tree-toolbar">
			<strong>Entities</strong>
			<div class="tree-toolbar-actions">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Expand all entities"
					title="Expand all entities"
					:disabled="!!sb.busy || tree.expandingAll || tree.loading"
					@click="tree.expandAll"
					><ChevronsUpDown :size="14"
				/></Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Collapse all entities"
					title="Collapse all entities"
					@click="tree.collapseAll"
					><ChevronsDownUp :size="14"
				/></Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Refresh entities"
					title="Refresh entities"
					:disabled="!!sb.busy || tree.expandingAll"
					@click="tree.refresh"
					><RefreshCw :size="14"
				/></Button>
			</div>
		</div>
		<div class="tree-bulk-toolbar">
			<Button
				variant="outline"
				size="sm"
				:disabled="!!sb.busy || tree.selectionBusy"
				:aria-pressed="tree.selectionMode"
				@click="tree.selectionMode = !tree.selectionMode"
				>Select entities</Button
			>
			<Button
				v-if="tree.selectedTargets.length"
				variant="outline"
				size="sm"
				:disabled="!!sb.busy || tree.selectionBusy"
				@click="emit('action', { type: 'bulk' })"
				>Bulk actions ({{ tree.selectedTargets.length }})…</Button
			>
			<Button
				v-if="tree.selectedTargets.length"
				variant="ghost"
				size="sm"
				:disabled="!!sb.busy || tree.selectionBusy"
				@click="tree.selectedTargets = []"
				>Clear selected entities</Button
			>
		</div>
		<p v-if="tree.selectionMode" class="tree-hint">
			Selection stays across filters and collapsed branches. Folder/group selection includes
			all pages and ignores the name filter.
		</p>
		<p v-if="tree.selectionBusy" role="status" class="tree-hint">
			Selecting entire scope… <button @click="tree.cancelSelection">Cancel selection</button>
		</p>
		<p v-if="tree.selectionError" role="alert" class="tree-hint">{{ tree.selectionError }}</p>
		<div class="tree-search">
			<Search :size="13" /><Input
				v-model="tree.filter"
				aria-label="Filter loaded entities"
				placeholder="Find an entity…"
			/>
		</div>
		<p v-if="tree.filter" class="tree-hint">
			Filters loaded names. Expand topics or load more to search their children.
		</p>
		<p v-if="tree.expandingAll" role="status" class="tree-hint">
			Expanding tree… <button @click="tree.stopExpanding">Stop</button>
		</p>
		<p v-if="tree.expansionError" role="alert" class="tree-hint">{{ tree.expansionError }}</p>
		<VirtualEntityTree v-if="virtualized" @action="emit('action', $event)" />
		<ul
			v-else
			role="tree"
			aria-label="Namespace entities"
			class="entity-tree-list"
			@keydown="keyboard"
		>
			<li
				v-for="kind in ['queue', 'topic'] as const"
				:key="kind"
				role="treeitem"
				:aria-expanded="tree.expanded[kind]"
			>
				<EntityContextMenu :context="{ kind }" @action="emit('action', $event)">
					<div class="tree-group-row">
						<button
							class="tree-toggle"
							:aria-label="`${tree.expanded[kind] ? 'Collapse' : 'Expand'} ${kind === 'queue' ? 'queues' : 'topics'}`"
							:aria-expanded="tree.expanded[kind]"
							@click="tree.expanded[kind] = !tree.expanded[kind]"
						>
							<component
								:is="tree.expanded[kind] ? ChevronDown : ChevronRight"
								:size="14"
							/></button
						><button class="tree-group" @click="group(kind)">
							{{ kind === 'queue' ? 'Queues' : 'Topics' }}
						</button>
						<small class="tree-group-count"
							>{{ tree.branch(kind).items.length
							}}{{ tree.branch(kind).continuationToken ? '+' : '' }}</small
						>
					</div>
				</EntityContextMenu>
				<ul v-if="tree.expanded[kind]" role="group">
					<EntityTreeBranch
						:items="tree.branch(kind).items"
						:kind="kind"
						@action="emit('action', $event)"
					/>
					<li v-if="tree.branch(kind).loading" class="tree-hint" role="none">Loading…</li>
					<li v-if="tree.branch(kind).error" class="tree-hint" role="none">
						<span role="alert">{{ tree.branch(kind).error }}</span
						><button @click="tree.load(kind)">
							Retry {{ kind === 'queue' ? 'queues' : 'topics' }}
						</button>
					</li>
					<li v-if="tree.branch(kind).continuationToken" role="none">
						<button
							class="tree-more"
							:disabled="tree.branch(kind).loading"
							@click="tree.load(kind, undefined, true)"
						>
							Load more {{ kind === 'queue' ? 'queues' : 'topics' }}
						</button>
					</li>
					<li
						v-if="tree.branch(kind).loaded && !tree.branch(kind).items.length"
						class="tree-hint"
						role="none"
					>
						No {{ kind === 'queue' ? 'queues' : 'topics' }}
					</li>
				</ul>
			</li>
		</ul>
	</aside>
</template>
