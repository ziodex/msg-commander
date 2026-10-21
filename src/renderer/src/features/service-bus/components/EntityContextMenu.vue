<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
	ContextMenuRoot,
	ContextMenuTrigger,
	ContextMenuPortal,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
} from 'reka-ui'
import {
	Plus,
	Pencil,
	Copy,
	TextCursorInput,
	Trash2,
	Send,
	Mail,
	MailWarning,
	RefreshCw,
} from '@lucide/vue'
import { useEntityTree } from '@/features/service-bus/stores/entity-tree'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useEntityCopy } from '@/features/service-bus/stores/entity-copy'
import { entityPath } from '@shared/entity-management'
import { subQueueLabel } from '@shared/service-bus'
import type { TreeAction, TreeContext } from '@/features/service-bus/lib/tree-actions'
const props = defineProps<{ context: TreeContext }>()
const emit = defineEmits<{ action: [action: TreeAction] }>()
const tree = useEntityTree()
const sb = useServiceBus(),
	copy = useEntityCopy(),
	open = ref(false)
const entity = computed(() => ('entity' in props.context ? props.context.entity : undefined))
const target = computed(() => entity.value?.target)
const subQueue = computed(() => ('entity' in props.context ? props.context.subQueue : undefined))
const kind = computed(
	() => target.value?.kind ?? ('kind' in props.context ? props.context.kind : 'queue'),
)
let focusTarget: HTMLElement | undefined
let handingOff = false
function remember(event: Event) {
	const element = event.target as HTMLElement
	focusTarget = element.closest('button') ?? element.querySelector('button') ?? element
	handingOff = false
}
function keyboard(event: KeyboardEvent) {
	if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
		event.preventDefault()
		event.stopPropagation()
		remember(event)
		open.value = true
	}
}
async function run(action: TreeAction) {
	if (sb.busy || !sb.connection) return
	// Capture the clicked destination before closing the menu or opening a dialog.
	const captured = JSON.parse(JSON.stringify(action)) as TreeAction
	handingOff = true
	open.value = false
	focusTarget?.focus()
	await nextTick()
	emit('action', captured)
}
function restoreFocus(event: Event) {
	event.preventDefault()
	if (!handingOff) focusTarget?.focus()
}
</script>
<template>
	<ContextMenuRoot v-model:open="open">
		<ContextMenuTrigger as-child @contextmenu="remember" @keydown="keyboard">
			<slot />
		</ContextMenuTrigger>
		<ContextMenuPortal>
			<ContextMenuContent
				class="entity-context-menu"
				:collision-padding="8"
				@close-auto-focus="restoreFocus"
			>
				<ContextMenuLabel class="entity-context-label"
					>{{ target ? entityPath(target) : kind === 'queue' ? 'Queues' : 'Topics'
					}}<small v-if="subQueue">{{ subQueueLabel(subQueue) }}</small></ContextMenuLabel
				>
				<ContextMenuItem
					v-if="target"
					:disabled="!!sb.busy || tree.loading"
					@select="run({ type: 'refresh', target })"
					><RefreshCw :size="14" />Refresh status</ContextMenuItem
				>
				<template v-if="!subQueue">
					<ContextMenuItem
						v-if="target"
						:disabled="!!sb.busy || tree.selectionBusy"
						@select="tree.toggleChecked(target)"
						>{{
							tree.isChecked(target)
								? 'Remove from bulk selection'
								: 'Add to bulk selection'
						}}</ContextMenuItem
					>
					<ContextMenuItem
						v-else
						:disabled="!!sb.busy || tree.selectionBusy"
						@select="tree.selectScope(kind)"
						>Select all {{ kind === 'queue' ? 'queues' : 'topics' }} for bulk
						actions…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="target?.kind === 'topic'"
						:disabled="!!sb.busy || tree.selectionBusy"
						@select="tree.selectScope('subscription', '', target.name)"
						>Select all subscriptions for bulk actions…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="tree.selectedTargets.length"
						:disabled="!!sb.busy || tree.selectionBusy"
						@select="run({ type: 'bulk' })"
						>Review bulk entity actions ({{
							tree.selectedTargets.length
						}})…</ContextMenuItem
					>
					<ContextMenuSeparator />
					<ContextMenuItem
						:disabled="!!sb.busy"
						@select="
							run({
								type: 'create',
								kind,
								topicName:
									target?.kind === 'subscription' ? target.topicName : undefined,
							})
						"
						><Plus :size="14" />Create {{ kind }}…</ContextMenuItem
					>
					<ContextMenuItem
						v-if="target?.kind === 'topic'"
						:disabled="!!sb.busy"
						@select="
							run({ type: 'create', kind: 'subscription', topicName: target.name })
						"
						><Plus :size="14" />Create subscription…</ContextMenuItem
					>
					<template v-if="target">
						<ContextMenuSeparator />
						<ContextMenuItem
							:disabled="!!sb.busy"
							@select="run({ type: 'edit', target })"
							><Pencil :size="14" />Edit {{ kind }}…</ContextMenuItem
						>
						<ContextMenuItem
							:disabled="!!sb.busy || copy.unresolved"
							@select="run({ type: 'duplicate', target })"
							><Copy :size="14" />Duplicate {{ kind }}…</ContextMenuItem
						>
						<ContextMenuItem
							:disabled="!!sb.busy || copy.unresolved"
							@select="run({ type: 'rename', target })"
							><TextCursorInput :size="14" />Rename {{ kind }}…</ContextMenuItem
						>
					</template>
				</template>
				<template v-if="target">
					<ContextMenuSeparator />
					<ContextMenuItem
						v-if="target.kind !== 'subscription'"
						:disabled="!!sb.busy"
						@select="run({ type: 'send', target })"
						><Send :size="14" />Send messages…</ContextMenuItem
					>
					<template v-if="!subQueue || subQueue === 'active'">
						<ContextMenuItem
							v-if="target.kind !== 'subscription'"
							:disabled="!!sb.busy"
							@select="run({ type: 'test-job', target, mode: 'send' })"
							><Send :size="14" />Run send test…</ContextMenuItem
						>
						<ContextMenuItem
							v-if="target.kind !== 'topic'"
							:disabled="!!sb.busy"
							@select="run({ type: 'test-job', target, mode: 'receive' })"
							><Mail :size="14" />Run receive test…</ContextMenuItem
						>
					</template>
					<template v-if="target.kind !== 'topic' && entity">
						<ContextMenuItem
							v-if="!subQueue || subQueue === 'active'"
							:disabled="!!sb.busy"
							@select="run({ type: 'listen', target })"
						>
							<Mail :size="14" />Listen for messages…
						</ContextMenuItem>
						<ContextMenuItem
							v-if="subQueue !== 'active'"
							:disabled="!!sb.busy"
							@select="
								run({ type: 'resend', target, subQueue: subQueue ?? 'dead-letter' })
							"
							><Send :size="14" />Resend
							{{ subQueueLabel(subQueue ?? 'dead-letter').toLowerCase() }}
							messages…</ContextMenuItem
						>
						<ContextMenuItem
							:disabled="!!sb.busy"
							@select="run({ type: 'peek', entity, subQueue: subQueue ?? 'active' })"
							><Mail :size="14" />{{
								!subQueue || subQueue === 'active'
									? 'Peek messages'
									: `Peek ${subQueueLabel(subQueue).toLowerCase()} messages`
							}}</ContextMenuItem
						>
						<ContextMenuItem
							v-if="!subQueue"
							:disabled="!!sb.busy"
							@select="run({ type: 'peek', entity, subQueue: 'dead-letter' })"
							><MailWarning :size="14" />Peek dead-letter messages</ContextMenuItem
						>
						<ContextMenuItem
							v-if="!subQueue"
							:disabled="!!sb.busy"
							@select="
								run({ type: 'peek', entity, subQueue: 'transfer-dead-letter' })
							"
							><MailWarning :size="14" />Peek transfer dead-letter
							messages</ContextMenuItem
						>
						<ContextMenuSeparator />
						<ContextMenuItem
							class="destructive"
							:disabled="!!sb.busy"
							@select="
								run({
									type: 'receive-delete',
									target,
									subQueue: subQueue ?? 'active',
								})
							"
							><Trash2 :size="14" />Receive &amp; delete…</ContextMenuItem
						>
						<ContextMenuItem
							v-if="!subQueue || subQueue === 'active'"
							class="destructive"
							:disabled="!!sb.busy"
							@select="run({ type: 'purge', target, subQueue: 'active' })"
							><Trash2 :size="14" />Purge messages…</ContextMenuItem
						>
						<ContextMenuItem
							v-if="subQueue !== 'active'"
							class="destructive"
							:disabled="!!sb.busy"
							@select="
								run({ type: 'purge', target, subQueue: subQueue ?? 'dead-letter' })
							"
							><Trash2 :size="14" />Purge
							{{ subQueueLabel(subQueue ?? 'dead-letter').toLowerCase() }}
							messages…</ContextMenuItem
						>
					</template>
					<template v-if="!subQueue">
						<ContextMenuSeparator />
						<ContextMenuItem
							class="destructive"
							:disabled="!!sb.busy"
							@select="run({ type: 'delete', target })"
							><Trash2 :size="14" />Delete {{ kind }}…</ContextMenuItem
						>
					</template>
				</template>
			</ContextMenuContent>
		</ContextMenuPortal>
	</ContextMenuRoot>
</template>
