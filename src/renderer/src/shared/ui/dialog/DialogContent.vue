<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from 'reka-ui'
import { computed, onBeforeUnmount, onMounted, ref, type HTMLAttributes } from 'vue'
import { Move, X } from '@lucide/vue'
import { reactiveOmit } from '@vueuse/core'
import { DialogClose, DialogContent, DialogPortal, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/shared/lib/utils'
import DialogOverlay from './DialogOverlay.vue'
import {
	fitDialog,
	resizeDialog,
	type DialogBounds,
	type ResizeEdge,
} from '@/shared/lib/dialog-geometry'

defineOptions({
	inheritAttrs: false,
})

const props = withDefaults(
	defineProps<
		DialogContentProps & {
			class?: HTMLAttributes['class']
			showCloseButton?: boolean
			movable?: boolean
			resizable?: boolean
		}
	>(),
	{
		showCloseButton: true,
	},
)
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, 'class', 'showCloseButton', 'movable', 'resizable')

const forwarded = useForwardPropsEmits(delegatedProps, emits)
const viewportElement = ref<HTMLElement>()
const bounds = ref<DialogBounds>()
const interaction = ref<'move' | ResizeEdge>()
const edges: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw']
const interactive = computed(() => props.movable || props.resizable)
const style = computed(() =>
	bounds.value
		? {
				'--dialog-width': bounds.value.width + 'px',
				'--dialog-height': bounds.value.height + 'px',
				left: bounds.value.left + 'px',
				top: bounds.value.top + 'px',
				transform: 'none',
				translate: 'none',
			}
		: undefined,
)
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })
function currentBounds(): DialogBounds | undefined {
	const rect = viewportElement.value?.parentElement?.getBoundingClientRect()
	return rect
		? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
		: undefined
}
let gesture:
	{ pointerId: number; x: number; y: number; start: DialogBounds; root: HTMLElement } | undefined
function endGesture(event?: PointerEvent) {
	if (event && gesture && event.pointerId !== gesture.pointerId) return
	const previous = gesture
	gesture = undefined
	interaction.value = undefined
	if (previous?.root.hasPointerCapture(previous.pointerId))
		previous.root.releasePointerCapture(previous.pointerId)
	window.removeEventListener('pointermove', pointerMove)
	window.removeEventListener('pointerup', endGesture)
	window.removeEventListener('pointercancel', endGesture)
}
function pointerMove(event: PointerEvent) {
	if (!gesture || gesture.pointerId !== event.pointerId || !interaction.value) return
	const dx = event.clientX - gesture.x,
		dy = event.clientY - gesture.y
	bounds.value =
		interaction.value === 'move'
			? fitDialog(
					{
						...gesture.start,
						left: gesture.start.left + dx,
						top: gesture.start.top + dy,
					},
					viewport(),
				)
			: resizeDialog(gesture.start, interaction.value, dx, dy, viewport())
}
function pointerDown(event: PointerEvent) {
	if (!interactive.value || event.button !== 0 || !event.isPrimary || gesture) return
	const target = event.target as HTMLElement
	const edge = target.closest<HTMLElement>('[data-dialog-resize]')?.dataset.dialogResize as
		ResizeEdge | undefined
	const moveControl = target.closest('[data-dialog-move]')
	const header = target.closest('[data-slot="dialog-header"]')
	const headerControl = target.closest('button, a, input, select, textarea, [contenteditable]')
	const mode =
		props.resizable && edge
			? edge
			: props.movable && (moveControl || (header && !headerControl))
				? 'move'
				: undefined
	const start = currentBounds()
	if (!mode || !start) return
	event.preventDefault()
	const root = event.currentTarget as HTMLElement
	bounds.value = fitDialog(start, viewport())
	interaction.value = mode
	gesture = {
		pointerId: event.pointerId,
		x: event.clientX,
		y: event.clientY,
		start: bounds.value,
		root,
	}
	root.setPointerCapture(event.pointerId)
	window.addEventListener('pointermove', pointerMove)
	window.addEventListener('pointerup', endGesture)
	window.addEventListener('pointercancel', endGesture)
}
function keyboard(event: KeyboardEvent, mode: 'move' | 'resize') {
	const start = currentBounds()
	if (!start) return
	const step = event.shiftKey ? 40 : 10
	const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
	const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
	if (event.key === 'Home')
		bounds.value =
			mode === 'resize'
				? undefined
				: fitDialog(
						{
							...start,
							left: (window.innerWidth - start.width) / 2,
							top: (window.innerHeight - start.height) / 2,
						},
						viewport(),
					)
	else if (dx || dy)
		bounds.value =
			mode === 'move'
				? fitDialog({ ...start, left: start.left + dx, top: start.top + dy }, viewport())
				: resizeDialog(start, 'se', dx, dy, viewport())
	else return
	event.preventDefault()
	event.stopPropagation()
}
function fitViewport() {
	if (bounds.value) bounds.value = fitDialog(bounds.value, viewport())
}
onMounted(() => window.addEventListener('resize', fitViewport))
onBeforeUnmount(() => {
	endGesture()
	window.removeEventListener('resize', fitViewport)
})
</script>

<template>
	<DialogPortal>
		<DialogOverlay />
		<DialogContent
			data-slot="dialog-content"
			v-bind="{ ...$attrs, ...forwarded }"
			:style="style"
			:data-adjusted="bounds ? true : undefined"
			:data-interaction="interaction"
			@pointerdown="pointerDown"
			@lostpointercapture="endGesture"
			@close-auto-focus="endGesture()"
			:class="
				cn(
					'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
					props.class,
					interactive && 'interactive-dialog',
				)
			"
		>
			<div
				v-if="interactive"
				ref="viewportElement"
				class="dialog-viewport"
				:data-movable="props.movable || undefined"
			>
				<slot />
			</div>
			<slot v-else />
			<button
				v-if="props.movable"
				type="button"
				class="dialog-window-control dialog-move"
				data-dialog-move
				aria-label="Move dialog"
				title="Move dialog · Arrow keys to move · Home to center"
				aria-description="Use arrow keys to move. Hold Shift for larger steps. Home centers the dialog."
				@keydown="keyboard($event, 'move')"
			>
				<Move :size="16" />
			</button>
			<template v-if="props.resizable">
				<span
					v-for="edge in edges"
					:key="edge"
					class="dialog-resize-edge"
					:class="'resize-' + edge"
					:data-dialog-resize="edge"
					aria-hidden="true"
				/>
				<button
					type="button"
					class="dialog-window-control dialog-resize-corner"
					data-dialog-resize="se"
					aria-label="Resize dialog"
					title="Resize dialog · Arrow keys to resize · Home to reset"
					aria-description="Use arrow keys to resize. Hold Shift for larger steps. Home resets the size."
					@keydown="keyboard($event, 'resize')"
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<path
							d="M4 12L12 4M8 12L12 8M12 12L12.01 11.99"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</template>

			<DialogClose
				v-if="showCloseButton"
				data-slot="dialog-close"
				class="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 z-10 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
			>
				<X />
				<span class="sr-only">Close</span>
			</DialogClose>
		</DialogContent>
	</DialogPortal>
</template>
