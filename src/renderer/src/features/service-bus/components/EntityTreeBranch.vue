<script setup lang="ts">
import { computed, watch } from 'vue'
import { ChevronDown, ChevronRight, Folder } from '@lucide/vue'
import type { Entity } from '@shared/service-bus'
import type { TreeAction } from '@/features/service-bus/lib/tree-actions'
import { entityKey } from '@/features/service-bus/lib/entity-counts'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import EntityTreeRow from './EntityTreeRow.vue'
const props = withDefaults(
	defineProps<{ items: Entity[]; kind: 'queue' | 'topic'; prefix?: string }>(),
	{ prefix: '' },
)
const emit = defineEmits<{ action: [action: TreeAction] }>()
const tree = useEntityTree(),
	sb = useServiceBus()
const groups = computed(() => {
	const direct: Entity[] = [],
		folders = new Map<string, Entity[]>()
	for (const item of props.items) {
		const remaining = item.target.name.slice(props.prefix ? props.prefix.length + 1 : 0)
		const slash = remaining.indexOf('/')
		if (slash < 0) direct.push(item)
		else {
			const prefix = (props.prefix ? props.prefix + '/' : '') + remaining.slice(0, slash)
			const list = folders.get(prefix) ?? []
			list.push(item)
			folders.set(prefix, list)
		}
	}
	return { direct, folders: [...folders].map(([prefix, items]) => ({ prefix, items })) }
})
watch(
	groups,
	(value) => {
		for (const folder of value.folders) {
			const key = tree.folderKey(props.kind, folder.prefix)
			if (tree.expanded[key] === undefined) tree.expanded[key] = true
		}
	},
	{ immediate: true },
)
</script>
<template>
	<EntityTreeRow
		v-for="entity in groups.direct"
		:key="entityKey(entity.target)"
		:entity="entity"
		@action="emit('action', $event)"
	/>
	<li
		v-for="folder in groups.folders"
		:key="folder.prefix"
		role="treeitem"
		:aria-expanded="tree.expanded[tree.folderKey(kind, folder.prefix)]"
	>
		<div class="tree-group-row">
			<button
				class="tree-toggle"
				:aria-expanded="tree.expanded[tree.folderKey(kind, folder.prefix)]"
				:aria-label="`Toggle folder ${folder.prefix}`"
				@click="
					tree.expanded[tree.folderKey(kind, folder.prefix)] =
						!tree.expanded[tree.folderKey(kind, folder.prefix)]
				"
			>
				<component
					:is="
						tree.expanded[tree.folderKey(kind, folder.prefix)]
							? ChevronDown
							: ChevronRight
					"
					:size="13"
				/>
			</button>
			<Folder :size="13" /><span class="tree-folder-name">{{
				folder.prefix.split('/').at(-1)
			}}</span>
			<button
				v-if="tree.selectionMode"
				class="tree-folder-select"
				:disabled="!!sb.busy || tree.selectionBusy"
				:aria-label="`Select entire ${kind} folder ${folder.prefix}`"
				@click="tree.selectScope(kind, folder.prefix)"
			>
				Select folder
			</button>
		</div>
		<ul
			v-if="tree.expanded[tree.folderKey(kind, folder.prefix)]"
			role="group"
			class="tree-children"
		>
			<EntityTreeBranch
				:items="folder.items"
				:kind="kind"
				:prefix="folder.prefix"
				@action="emit('action', $event)"
			/>
		</ul>
	</li>
</template>
