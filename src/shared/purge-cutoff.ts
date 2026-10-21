import { purgeCutoffSchema } from './contracts/service-bus/maintenance/index'

export interface PurgeCutoffSelection {
	enabled: boolean
	dateTime: string
	zone: 'local' | 'utc'
}
export const emptyPurgeCutoff = (): PurgeCutoffSelection => ({
	enabled: false,
	dateTime: '',
	zone: 'local',
})
// undefined means disabled; null means an enabled but invalid/ambiguous selection.
export function selectedPurgeCutoff(selection: PurgeCutoffSelection): string | null | undefined {
	if (!selection.enabled) return undefined
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(selection.dateTime)
	if (!match) return null
	const [, year, month, day, hour, minute, second = '00'] = match
	const parts = [year, month, day, hour, minute, second].map(Number)
	const expected = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
	if (!purgeCutoffSchema.safeParse(expected).success) return null
	if (selection.zone === 'utc') return expected
	const date = new Date(selection.dateTime)
	const matches = (value: Date) =>
		[
			value.getFullYear(),
			value.getMonth() + 1,
			value.getDate(),
			value.getHours(),
			value.getMinutes(),
			value.getSeconds(),
		].every((part, index) => part === parts[index])
	if (!Number.isFinite(date.getTime()) || !matches(date)) return null // DST gap; never normalize silently.
	// Reject repeated local clock times so the user can choose an explicit UTC instant.
	for (let minutes = -180; minutes <= 180; minutes += 15) {
		if (minutes !== 0 && matches(new Date(date.getTime() + minutes * 60000))) return null
	}
	return date.toISOString()
}
export function describePurgeCutoff(instant: string): string {
	return `${new Date(instant).toLocaleString(undefined, { timeZoneName: 'short' })} · ${instant} (UTC)`
}
