import { expect, it } from 'vitest'
import { flattenEntityTree } from '../../src/renderer/src/features/service-bus/lib/virtual-tree'
import { entityKey } from '../../src/renderer/src/features/service-bus/lib/entity-counts'
import type { Entity } from '../../src/shared/service-bus'
const entity = (name: string, kind: 'queue' | 'topic' = 'queue'): Entity => ({
	target: { kind, name },
	status: 'Active',
	requiresSession: false,
})
const branch = (items: Entity[]) => ({
	items,
	loaded: true,
	loading: false,
	error: '',
	continuationToken: null,
})
it('flattens folders and subqueues without changing entity identity or scope', () => {
	const queue = entity('team/orders')
	const rows = flattenEntityTree(
		{ queue: branch([queue, entity('teamwork/other')]), topic: branch([]) },
		{ queue: true, topic: true, [entityKey(queue.target)]: true },
		'orders',
	)
	expect(
		rows
			.filter((row) => row.type === 'folder')
			.map((row) => row.type === 'folder' && row.prefix),
	).toEqual(['team'])
	expect(
		rows.filter((row) => row.type === 'leaf').map((row) => row.type === 'leaf' && row.subQueue),
	).toEqual(['active', 'dead-letter', 'transfer-dead-letter'])
	expect(rows.find((row) => row.type === 'entity')?.level).toBe(3)
	const collapsed = flattenEntityTree(
		{ queue: branch([queue]) },
		{ queue: true, 'folder:queue:team': false },
		'',
	)
	expect(collapsed.some((row) => row.type === 'entity')).toBe(false)
})
it('preserves loaded paging and errors while filtering and expanding 10,000 entities', () => {
	const queues = branch(
		Array.from({ length: 10000 }, (_, index) => entity('q-' + String(index).padStart(5, '0'))),
	)
	const input = { queue: { ...queues, continuationToken: 'next', error: 'Page failed' } }
	const rows = flattenEntityTree(input, { queue: true }, '')
	expect(rows.filter((row) => row.type === 'entity')).toHaveLength(10000)
	expect(rows.some((row) => row.type === 'more' && row.kind === 'queue')).toBe(true)
	expect(rows.some((row) => row.type === 'hint' && row.error)).toBe(true)
	const filtered = flattenEntityTree(input, { queue: true }, '09999')
	expect(filtered.filter((row) => row.type === 'entity')).toHaveLength(1)
	expect(queues.items).toHaveLength(10000)
})
