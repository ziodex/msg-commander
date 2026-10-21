<script setup lang="ts">
import { computed } from 'vue'
import {
	ChevronRight,
	ChevronDown,
	Inbox,
	Layers,
	ListFilter,
	Mail,
	MailWarning,
} from '@lucide/vue'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useNamespaceMonitor } from '@/features/service-bus/stores/namespace-monitor'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import { entityKey, countText } from '@/features/service-bus/lib/entity-counts'
import { entityPath } from '@shared/entity-management'
import { subQueueLabel, type Entity } from '@shared/service-bus'
import type { TreeAction } from '@/features/service-bus/lib/tree-actions'
import EntityContextMenu from './EntityContextMenu.vue'
const props = defineProps<{ entity: Entity; flat?: boolean }>()
const workspace = useWorkspace()
const emit = defineEmits<{ action: [action: TreeAction] }>()
const tree = useEntityTree(),
	monitor = useNamespaceMonitor(),
	sb = useServiceBus()
const key = computed(() => entityKey(props.entity.target)),
	open = computed(() => tree.expanded[key.value]),
	selected = computed(() => !!sb.selected && entityKey(sb.selected.target) === key.value)
const counts = computed(() =>
	workspace.preferences.showMessageCounts ? monitor.counts(props.entity.target) : undefined,
)
const children = computed(() => tree.branch('subscription', props.entity.target.name))
const matches = computed(
	() =>
		props.entity.target.kind === 'topic' ||
		props.entity.target.name.toLowerCase().includes(tree.filter.toLowerCase()),
)
</script>
<template>
	<li v-if="matches" role="treeitem" :aria-expanded="!!open" :aria-selected="selected">
		<EntityContextMenu :context="{ entity }" @action="emit('action', $event)">
			<div class="tree-row" :class="{ selected }">
				<input
					v-if="tree.selectionMode"
					type="checkbox"
					class="tree-check"
					:aria-label="`Select ${entity.target.kind} ${entityPath(entity.target)} for bulk actions`"
					:checked="tree.isChecked(entity.target)"
					:disabled="!!sb.busy || tree.selectionBusy"
					@change="tree.toggleChecked(entity.target)"
				/>
				<button
					class="tree-toggle"
					:aria-label="`${open ? 'Collapse' : 'Expand'} ${entity.target.kind} ${entityPath(entity.target)}`"
					:aria-expanded="!!open"
					@click="tree.toggle(entity)"
				>
					<component :is="open ? ChevronDown : ChevronRight" :size="13" />
				</button>
				<button
					class="tree-entity"
					:disabled="!!sb.busy"
					:aria-label="`${entity.target.name}${entity.requiresSession ? ' Sessions' : ''} ${entity.status}`"
					:title="entityPath(entity.target) + ' · ' + entity.status"
					:aria-pressed="selected"
					@click="tree.select(entity)"
				>
					<component
						:is="
							entity.target.kind === 'topic'
								? Layers
								: entity.target.kind === 'queue'
									? Inbox
									: ListFilter
						"
						:size="14"
					/><span
						>{{ entity.target.name }}
						<small v-if="entity.requiresSession">Sessions</small>
						<small v-if="entity.status !== 'Active'">{{ entity.status }}</small></span
					>
				</button>
				<span
					v-if="workspace.preferences.showMessageCounts && entity.target.kind !== 'topic'"
					class="tree-badge"
					title="Active messages"
					>{{ countText(counts?.active) }}</span
				>
				<span
					v-if="counts?.deadLetter && counts.deadLetter !== '0'"
					class="tree-badge tree-dlq"
					title="Dead-letter messages"
					>{{ countText(counts.deadLetter) }} DLQ</span
				>
				<span
					v-if="counts?.transferDeadLetter && counts.transferDeadLetter !== '0'"
					class="tree-badge tree-dlq"
					title="Transfer dead-letter messages"
					>{{ countText(counts.transferDeadLetter) }} TDLQ</span
				>
			</div>
		</EntityContextMenu>
		<ul v-if="open && !flat" role="group" class="tree-children">
			<template v-if="entity.target.kind === 'topic'">
				<li v-if="children.loading" class="tree-hint" role="none">
					Loading subscriptions…
				</li>
				<li v-if="children.error" class="tree-hint" role="none">
					<span role="alert">{{ children.error }}</span
					><button @click="tree.load('subscription', entity.target.name)">
						Retry subscriptions
					</button>
				</li>
				<EntityTreeRow
					v-for="child in children.items"
					:key="entityKey(child.target)"
					:entity="child"
					@action="emit('action', $event)"
				/>
				<li v-if="children.loaded && !children.items.length" class="tree-hint" role="none">
					No subscriptions
				</li>
				<li v-if="children.continuationToken" role="none">
					<button
						class="tree-more"
						:disabled="children.loading"
						@click="tree.load('subscription', entity.target.name, true)"
					>
						Load more subscriptions
					</button>
				</li>
			</template>
			<template v-else>
				<li
					v-for="leaf in ['active', 'dead-letter', 'transfer-dead-letter'] as const"
					:key="leaf"
					role="treeitem"
					:aria-selected="selected && sb.subQueue === leaf && !!sb.messages"
				>
					<EntityContextMenu
						:context="{ entity, subQueue: leaf }"
						@action="emit('action', $event)"
					>
						<div
							class="tree-row"
							:class="{ selected: selected && sb.subQueue === leaf && !!sb.messages }"
						>
							<button
								class="tree-leaf"
								:class="{
									selected: selected && sb.subQueue === leaf && !!sb.messages,
								}"
								:disabled="!!sb.busy"
								:aria-label="`${entityPath(entity.target)} ${subQueueLabel(leaf)}`"
								@click="tree.select(entity, leaf)"
							>
								<component
									:is="leaf === 'active' ? Mail : MailWarning"
									:size="13"
								/><span>{{ subQueueLabel(leaf) }}</span>
							</button>
							<span :class="{ 'tree-dlq': leaf !== 'active' }" class="tree-badge">{{
								countText(
									leaf === 'active'
										? counts?.active
										: leaf === 'dead-letter'
											? counts?.deadLetter
											: counts?.transferDeadLetter,
								)
							}}</span>
						</div>
					</EntityContextMenu>
				</li>
			</template>
		</ul>
	</li>
</template>
