import { expect, it } from 'vitest'
import { effectScope, ref } from 'vue'
import { useBodyFormat } from '../../src/renderer/src/shared/composables/use-body-format'
import { fitDialog, resizeDialog } from '../../src/renderer/src/shared/lib/dialog-geometry'

it('selects JSON after asynchronous loading while preserving manual formats for the same message', () => {
	const scope = effectScope()
	scope.run(() => {
		const identity = ref<string | null>('first'),
			json = ref<string | null>(null)
		const { format, selectFormat } = useBodyFormat(() => identity.value, json)
		expect(format.value).toBe('text')
		json.value = '{"n":9007199254740993}'
		expect(format.value).toBe('json')
		selectFormat('text')
		json.value = '{"n":9007199254740993,"more":true}'
		expect(format.value).toBe('text')
		selectFormat('hex')
		json.value = null
		json.value = '[]'
		expect(format.value).toBe('hex')
		identity.value = 'second'
		expect(format.value).toBe('json')
		selectFormat('json')
		json.value = null
		expect(format.value).toBe('text')
		json.value = '[]'
		expect(format.value).toBe('json')
	})
	scope.stop()
})
it('keeps moved dialogs and their controls within a shrinking viewport', () => {
	expect(
		fitDialog({ left: -100, top: 900, width: 1100, height: 700 }, { width: 800, height: 600 }),
	).toEqual({ left: 12, top: 12, width: 776, height: 576 })
	expect(
		fitDialog({ left: 400, top: 300, width: 100, height: 100 }, { width: 300, height: 200 }),
	).toEqual({ left: 12, top: 12, width: 276, height: 176 })
})
it('resizes from opposing edges without moving the anchored corner or shrinking past usable limits', () => {
	const start = { left: 100, top: 100, width: 600, height: 400 },
		viewport = { width: 1400, height: 1000 }
	expect(resizeDialog(start, 'nw', -40, -30, viewport)).toEqual({
		left: 60,
		top: 70,
		width: 640,
		height: 430,
	})
	expect(resizeDialog(start, 'se', -1000, -1000, viewport)).toEqual({
		...start,
		width: 420,
		height: 280,
	})
	expect(resizeDialog(start, 'se', 2000, 2000, viewport)).toEqual({
		...start,
		width: 1288,
		height: 888,
	})
	expect(resizeDialog(start, 'nw', 2000, 2000, viewport)).toEqual({
		left: 280,
		top: 220,
		width: 420,
		height: 280,
	})
})
