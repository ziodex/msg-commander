import type { Entity, MessageSubQueue } from '@shared/service-bus'
import { entityKey, branchKey } from './entity-counts'

type Branch = {
	items: Entity[]
	loaded: boolean
	loading: boolean
	error: string
	continuationToken: string | null
}
type Kind = 'queue' | 'topic' | 'subscription'
export type TreeRow = {
	key: string
	parent?: string
	level: number
	height: number
	position?: number
	setSize?: number
} & (
	| { type: 'group'; kind: 'queue' | 'topic'; count: number; more: boolean; expanded: boolean }
	| { type: 'folder'; kind: 'queue' | 'topic'; prefix: string; expanded: boolean }
	| { type: 'entity'; entity: Entity }
	| { type: 'leaf'; entity: Entity; subQueue: MessageSubQueue }
	| { type: 'hint'; text: string; error: boolean; kind: Kind; topic?: string }
	| { type: 'more'; kind: Kind; topic?: string; loading: boolean }
)
export function flattenEntityTree(
	branches: Record<string, Branch>,
	expanded: Record<string, boolean>,
	filter: string,
): TreeRow[] {
	const rows: TreeRow[] = []
	const needle = filter.toLowerCase()
	const branch = (kind: Kind, topic?: string) => branches[branchKey(kind, topic)]
	function tail(kind: Kind, parent: string, level: number, topic?: string) {
		const value = branch(kind, topic)
		if (!value) return
		const text = value.loading
			? 'Loading…'
			: value.error ||
				(value.loaded && !value.items.length
					? 'No ' + (kind === 'subscription' ? 'subscriptions' : kind + 's')
					: '')
		if (text)
			rows.push({
				key: parent + ':hint',
				parent,
				level,
				height: 40,
				type: 'hint',
				text,
				error: !!value.error,
				kind,
				topic,
			})
		if (value.continuationToken)
			rows.push({
				key: parent + ':more',
				parent,
				level,
				height: 32,
				type: 'more',
				kind,
				topic,
				loading: value.loading,
			})
	}
	function entity(item: Entity, parent: string, level: number) {
		if (item.target.kind !== 'topic' && !item.target.name.toLowerCase().includes(needle)) return
		const key = entityKey(item.target)
		rows.push({ key, parent, level, height: 40, type: 'entity', entity: item })
		if (!expanded[key]) return
		if (item.target.kind === 'topic') {
			for (const child of branch('subscription', item.target.name)?.items ?? [])
				entity(child, key, level + 1)
			tail('subscription', key, level + 1, item.target.name)
		} else
			for (const subQueue of ['active', 'dead-letter', 'transfer-dead-letter'] as const)
				rows.push({
					key: key + ':' + subQueue,
					parent: key,
					level: level + 1,
					height: 32,
					type: 'leaf',
					entity: item,
					subQueue,
				})
	}
	function folders(
		items: Entity[],
		kind: 'queue' | 'topic',
		prefix: string,
		parent: string,
		level: number,
	) {
		const direct: Entity[] = [],
			groups = new Map<string, Entity[]>()
		for (const item of items) {
			if (kind !== 'topic' && !item.target.name.toLowerCase().includes(needle)) continue
			const rest = item.target.name.slice(prefix ? prefix.length + 1 : 0),
				slash = rest.indexOf('/')
			if (slash < 0) direct.push(item)
			else {
				const path = (prefix ? prefix + '/' : '') + rest.slice(0, slash)
				const children = groups.get(path) ?? []
				children.push(item)
				groups.set(path, children)
			}
		}
		for (const item of direct) entity(item, parent, level)
		for (const [path, children] of groups) {
			const key = `folder:${kind}:${path}`,
				open = expanded[key] !== false
			rows.push({
				key,
				parent,
				level,
				height: 32,
				type: 'folder',
				kind,
				prefix: path,
				expanded: open,
			})
			if (open) folders(children, kind, path, key, level + 1)
		}
	}
	for (const kind of ['queue', 'topic'] as const) {
		const value = branch(kind)
		rows.push({
			key: kind,
			level: 1,
			height: 32,
			type: 'group',
			kind,
			count: value?.items.length ?? 0,
			more: !!value?.continuationToken,
			expanded: !!expanded[kind],
		})
		if (expanded[kind]) {
			folders(value?.items ?? [], kind, '', kind, 2)
			tail(kind, kind, 2)
		}
	}
	const siblings = new Map<string, TreeRow[]>()
	for (const row of rows) {
		if (row.type === 'hint' || row.type === 'more') continue
		const group = siblings.get(row.parent ?? '') ?? []
		group.push(row)
		siblings.set(row.parent ?? '', group)
	}
	for (const group of siblings.values())
		group.forEach((row, index) => {
			row.position = index + 1
			row.setSize = group.length
		})
	return rows
}
