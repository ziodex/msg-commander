import { z } from 'zod'
import { documentFormatSchema } from '../../document-formats'
import {
	eventHubsRequestSchema,
	eventHubRequestSchema,
	consumerGroupSchema,
	eventDetailsSchema,
} from './core'
import { eventCheckpointSchema, eventListenResultRequestSchema } from './listening'
import { eventDraftSchema } from './sending'
import { propertySchema, sequenceSchema } from '../../service-bus'
export const eventSourceSchema = z
	.object({
		namespace: z.string().max(253),
		hubName: z.string().max(256),
		consumerGroup: z.string().max(50),
		partitionId: z.string().max(128),
	})
	.strict()
export const eventExportMetadataSchema = eventSourceSchema.extend({ details: eventDetailsSchema })
export const archiveEventSchema = z
	.object({
		source: eventSourceSchema.nullable(),
		sequenceNumber: sequenceSchema.nullable(),
		offset: z.string().max(256).nullable(),
		enqueuedTime: z.string().max(64).nullable(),
		partitionKey: z.string().max(256).nullable(),
		messageId: z.string().max(256).nullable(),
		contentType: z.string().max(256).nullable(),
		correlationId: z.string().max(256).nullable(),
		applicationProperties: z.array(propertySchema).max(64),
		systemProperties: z.array(propertySchema).max(64),
		bodyBase64: z.string().max(89478488),
	})
	.strict()
export const eventArchiveSchema = z
	.object({
		format: documentFormatSchema('events'),
		version: z.literal(1),
		exportedAt: z.iso.datetime({ offset: true }),
		events: z.array(archiveEventSchema).min(1).max(1000),
	})
	.strict()
export const eventExportSchema = eventHubsRequestSchema
	.extend({
		snapshotIds: z.array(z.string().uuid()).min(1).max(1000),
		format: z.enum(['archive', 'body']),
	})
	.refine(
		(v) =>
			new Set(v.snapshotIds).size === v.snapshotIds.length &&
			(v.format === 'archive' || v.snapshotIds.length === 1),
		'Choose distinct events, or one body.',
	)
export const eventFileDraftsSchema = z
	.array(eventDraftSchema)
	.min(1)
	.max(20)
	.refine(
		(v) => new TextEncoder().encode(JSON.stringify(v)).length <= 524288,
		'Select fewer events: the composer accepts 20 drafts and 512 KiB of serialized drafts.',
	)
export const eventSaveDraftsSchema = eventHubsRequestSchema.extend({
	drafts: eventFileDraftsSchema,
})
export const eventImportSchema = eventHubsRequestSchema.extend({
	format: z.enum(['archive', 'body']),
})
export const eventImportEntrySchema = z
	.object({
		id: z.string().uuid(),
		fileName: z.string().max(1024),
		index: z.number().int(),
		bodySize: z.number().int().nonnegative(),
		source: eventSourceSchema.nullable(),
		fullIssue: z.string().max(1024).nullable(),
		bodyIssue: z.string().max(1024).nullable(),
		warnings: z.array(z.string().max(512)).max(8).optional(),
	})
	.strict()
export const eventImportPreviewSchema = z
	.object({
		cancelled: z.boolean(),
		importId: z.string().uuid().optional(),
		items: z.array(eventImportEntrySchema).max(1000),
	})
	.strict()
export const eventLoadImportSchema = eventHubsRequestSchema
	.extend({
		importId: z.string().uuid(),
		entryIds: z.array(z.string().uuid()).min(1).max(20),
		mode: z.enum(['full', 'body']),
	})
	.refine((v) => new Set(v.entryIds).size === v.entryIds.length, 'Select distinct events.')
export const eventDiscardImportSchema = eventHubsRequestSchema.extend({
	importId: z.string().uuid(),
})
export const eventCheckpointSaveSchema = eventListenResultRequestSchema
export const eventCheckpointLoadSchema = eventHubRequestSchema.extend({
	consumerGroup: consumerGroupSchema,
})
export const eventCheckpointLoadResultSchema = z
	.object({
		cancelled: z.boolean(),
		fileName: z.string().optional(),
		checkpoint: eventCheckpointSchema.nullable(),
	})
	.strict()
export type ArchiveEvent = z.infer<typeof archiveEventSchema>
export type EventExportMetadata = z.infer<typeof eventExportMetadataSchema>
export type EventExport = z.infer<typeof eventExportSchema>
export type EventSaveDrafts = z.infer<typeof eventSaveDraftsSchema>
export type EventImport = z.infer<typeof eventImportSchema>
export type EventImportPreview = z.infer<typeof eventImportPreviewSchema>
export type EventLoadImport = z.infer<typeof eventLoadImportSchema>
export type EventDiscardImport = z.infer<typeof eventDiscardImportSchema>
export type EventCheckpointLoad = z.infer<typeof eventCheckpointLoadSchema>
export type EventCheckpointLoadResult = z.infer<typeof eventCheckpointLoadResultSchema>
