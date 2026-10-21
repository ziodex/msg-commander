import {
	eventHubCopyUrlSchema,
	type EventHubCopyUrl,
} from '../../../shared/contracts/event-hubs/core'
// Only non-secret resource addresses derived from the active connection reach the clipboard.
export function eventHubUrl(namespace: string, request: EventHubCopyUrl): string {
	const { target, scheme } = eventHubCopyUrlSchema.parse(request)
	if (!/^[a-z0-9-]+\.servicebus\.windows\.net$/i.test(namespace))
		throw new Error('Invalid Event Hubs namespace.')
	const path: string[] = []
	if (target.kind !== 'namespace') path.push(target.hubName)
	if (target.kind === 'group' || target.kind === 'partition')
		path.push('consumergroups', target.consumerGroup)
	if (target.kind === 'partition') path.push('partitions', target.partitionId)
	return `${scheme}://${namespace}${path.length ? '/' + path.map(encodeURIComponent).join('/') : ''}`
}
