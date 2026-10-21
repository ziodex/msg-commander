export type DialogBounds = { left: number; top: number; width: number; height: number }
export type DialogViewport = { width: number; height: number }
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const margin = 12
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
export function fitDialog(bounds: DialogBounds, viewport: DialogViewport): DialogBounds {
	const maxWidth = Math.max(1, viewport.width - margin * 2)
	const maxHeight = Math.max(1, viewport.height - margin * 2)
	const width = clamp(bounds.width, Math.min(420, maxWidth), maxWidth)
	const height = clamp(bounds.height, Math.min(280, maxHeight), maxHeight)
	return {
		width,
		height,
		left: clamp(bounds.left, margin, Math.max(margin, viewport.width - margin - width)),
		top: clamp(bounds.top, margin, Math.max(margin, viewport.height - margin - height)),
	}
}
export function resizeDialog(
	bounds: DialogBounds,
	edge: ResizeEdge,
	dx: number,
	dy: number,
	viewport: DialogViewport,
): DialogBounds {
	const start = fitDialog(bounds, viewport)
	let { left, top, width, height } = start
	const right = left + width,
		bottom = top + height
	const minWidth = Math.min(420, Math.max(1, viewport.width - margin * 2))
	const minHeight = Math.min(280, Math.max(1, viewport.height - margin * 2))
	if (edge.includes('w')) {
		left = clamp(left + dx, margin, right - minWidth)
		width = right - left
	}
	if (edge.includes('n')) {
		top = clamp(top + dy, margin, bottom - minHeight)
		height = bottom - top
	}
	if (edge.includes('e')) width = clamp(width + dx, minWidth, viewport.width - margin - left)
	if (edge.includes('s')) height = clamp(height + dy, minHeight, viewport.height - margin - top)
	return { left, top, width, height }
}
