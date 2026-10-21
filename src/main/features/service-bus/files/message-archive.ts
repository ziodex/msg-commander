import { z } from 'zod'
import { documentFormatSchema } from '../../../../shared/document-formats'
import { randomUUID } from 'node:crypto'
import { draftSchema, type MessageDraft } from '../../../../shared/message-operations'
import type { Property } from '../../../../shared/service-bus'
export const ARCHIVE_FORMAT = 'msg-commander/messages'
export const IMPORT_LIMIT = 16 * 1024 * 1024
export const EXPORT_LIMIT = 96 * 1024 * 1024
const property = z
	.object({
		name: z.string().max(32768),
		type: z.string().max(128),
		value: z.string().max(900000),
	})
	.strict()
const properties = z
	.array(property)
	.max(4096)
	.refine(
		(items) => new Set(items.map((item) => item.name)).size === items.length,
		'Duplicate property names.',
	)
export const archiveMessageSchema = z
	.object({
		bodyBase64: z.string().max(IMPORT_LIMIT),
		systemProperties: properties,
		applicationProperties: properties,
	})
	.strict()
export const archiveSchema = z
	.object({
		format: documentFormatSchema('messages'),
		version: z.literal(1),
		exportedAtUtc: z.iso.datetime({ offset: true }),
		messages: z.array(archiveMessageSchema).min(1).max(100),
	})
	.strict()
export type ArchiveMessage = z.infer<typeof archiveMessageSchema>
export function decodeBody(value: string): Buffer {
	if (value.length % 4 || /[^A-Za-z0-9+/=]/.test(value))
		throw new Error('Body is not canonical base64.')
	const bytes = Buffer.from(value, 'base64')
	if (bytes.toString('base64') !== value) throw new Error('Body is not canonical base64.')
	return bytes
}
export function emptyDraft(
	bodyBase64: string,
	contentType = 'application/octet-stream',
): MessageDraft {
	return {
		bodyBase64,
		messageId: randomUUID(),
		subject: '',
		contentType,
		correlationId: '',
		sessionId: '',
		replyTo: '',
		replyToSessionId: '',
		to: '',
		partitionKey: '',
		ttlSeconds: null,
		properties: [],
	}
}
const headers = {
	messageId: 'MessageId',
	subject: 'Subject',
	contentType: 'ContentType',
	correlationId: 'CorrelationId',
	sessionId: 'SessionId',
	replyTo: 'ReplyTo',
	replyToSessionId: 'ReplyToSessionId',
	to: 'To',
	partitionKey: 'PartitionKey',
} as const
export function messageId(record: ArchiveMessage): string | null {
	const property = record.systemProperties.find((property) => property.name === 'MessageId')
	return property?.type === 'string' ? property.value : null
}
export function toDraft(record: ArchiveMessage): MessageDraft {
	const draft = emptyDraft(record.bodyBase64)
	const values = new Map(record.systemProperties.map((property) => [property.name, property]))
	for (const [field, name] of Object.entries(headers)) {
		const value = values.get(name)
		if (value && value.type !== 'null' && value.type !== 'string')
			throw new Error(
				`${name} has an unsupported type. Use body only or correct the archive.`,
			)
		// Missing/blank IDs do not block the default new-ID policy; preservation is checked at load time.
		if (field === 'messageId' && !value?.value.trim()) continue
		draft[field as keyof typeof headers] =
			value?.type === 'string' ? value.value : field === 'messageId' ? draft.messageId : ''
	}
	const ttl = values.get('TimeToLive')
	if (ttl && ttl.type !== 'null') {
		if (ttl.type !== 'timespan') throw new Error('TimeToLive must use the timespan type.')
		draft.ttlDuration = ttl.value
	}
	for (const property of record.applicationProperties) {
		if (
			![
				'string',
				'boolean',
				'int32',
				'int64',
				'uint64',
				'double',
				'decimal',
				'guid',
				'datetime',
				'timespan',
			].includes(property.type)
		)
			throw new Error(
				`Application property type “${property.type}” cannot be sent by this composer. Use body only or edit the archive explicitly.`,
			)
	}
	const parsed = draftSchema.safeParse({ ...draft, properties: record.applicationProperties })
	if (!parsed.success)
		throw new Error(
			'Headers, body or properties exceed composer limits. Use body only or edit the archive.',
		)
	return parsed.data
}
export function fromDraft(draft: MessageDraft): ArchiveMessage {
	const systemProperties: Property[] = Object.entries(headers).map(([field, name]) => ({
		name,
		type: 'string',
		value: draft[field as keyof typeof headers],
	}))
	let ttl = draft.ttlDuration
	if (!ttl && draft.ttlSeconds !== null) {
		const seconds = draft.ttlSeconds
		ttl = `${Math.floor(seconds / 86400)}.${String(Math.floor((seconds % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
	}
	systemProperties.push({
		name: 'TimeToLive',
		type: ttl ? 'timespan' : 'null',
		value: ttl ?? 'null',
	})
	return {
		bodyBase64: draft.bodyBase64,
		systemProperties,
		applicationProperties: draft.properties,
	}
}
