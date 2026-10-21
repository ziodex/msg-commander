import type { EntityTarget, RuntimeEntity } from '@shared/service-bus'
export const entityKey = (target: EntityTarget) =>
	JSON.stringify([
		target.kind,
		target.kind === 'subscription' ? target.topicName.toLowerCase() : '',
		target.name.toLowerCase(),
	])
export const branchKey = (kind: EntityTarget['kind'], topic?: string) =>
	kind === 'subscription' ? `subscriptions:${topic?.toLowerCase()}` : kind
export const metrics = {
	active: 'Active messages',
	deadLetter: 'Dead-letter',
	scheduled: 'Scheduled',
	transfer: 'In transfer',
	transferDeadLetter: 'Transfer DLQ',
	total: 'Total stored',
} as const
export type Metric = keyof typeof metrics
export function totalCounts(rows: RuntimeEntity[], complete: boolean) {
	return Object.fromEntries(
		Object.keys(metrics).map((key) => {
			const metric = key as Metric
			let sum = 0n,
				known = 0,
				missing = !complete
			for (const row of rows) {
				// Topics own scheduled messages; their subscriptions own delivered copies.
				if (
					metric === 'scheduled'
						? row.target.kind === 'subscription'
						: metric !== 'total' && row.target.kind === 'topic'
				)
					continue
				const value =
					row.target.kind === 'topic' ? row.counts.scheduled : row.counts[metric]
				if (value === null) missing = true
				else {
					sum += BigInt(value)
					known++
				}
			}
			return [metric, { value: !known && missing ? null : sum.toString(), partial: missing }]
		}),
	) as Record<Metric, { value: string | null; partial: boolean }>
}
export function countText(value: string | null | undefined, partial = false) {
	return value == null ? '—' : `${partial ? '≥ ' : ''}${BigInt(value).toLocaleString()}`
}
