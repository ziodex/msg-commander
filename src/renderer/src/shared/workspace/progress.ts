import type { Job } from './store'

type Progress = NonNullable<Job['progress']>
function matches<T extends Progress['type']>(
	event: Job['progress'],
	type: T,
): event is Extract<Progress, { type: T }> {
	return event?.type === type
}
export function progressFor<T extends Progress['type']>(job: Job | undefined, type: T) {
	const event = job?.progress
	return matches(event, type) ? event : undefined
}
