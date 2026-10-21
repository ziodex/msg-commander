import { z } from 'zod'
import { draftSchema } from './message-operations'
const id = z.string().uuid()
const base = z.object({ id, connectionId: id }).strict()
const ids = (max: number) =>
	z
		.array(id)
		.min(1)
		.max(max)
		.refine((items) => new Set(items).size === items.length, 'Choose distinct messages.')
export const fileDraftsSchema = z
	.array(draftSchema)
	.min(1)
	.max(20)
	.refine(
		(drafts) => new TextEncoder().encode(JSON.stringify(drafts)).length <= 524288,
		'Selected drafts exceed the 512 KiB batch limit. Select fewer messages.',
	)
export const exportMessagesRequestSchema = base
	.extend({
		snapshotIds: ids(25),
		format: z.enum(['archive', 'body']),
		destination: z.enum(['file', 'clipboard']).optional(),
	})
	.refine(
		(value) => value.format === 'archive' || value.snapshotIds.length === 1,
		'Save one body at a time.',
	)
	.refine(
		(value) => value.destination !== 'clipboard' || value.format === 'archive',
		'Copy messages as an archive.',
	)
export const saveDraftsRequestSchema = base.extend({ drafts: fileDraftsSchema })
export const importMessagesRequestSchema = base.extend({
	format: z.enum(['archive', 'body']),
})
export const loadImportedRequestSchema = base.extend({
	importId: id,
	entryIds: ids(20),
	mode: z.enum(['full', 'body']),
	idPolicy: z.enum(['new', 'preserve']),
})
export const discardImportRequestSchema = base.extend({ importId: id })
export type ExportMessagesRequest = z.infer<typeof exportMessagesRequestSchema>
export type SaveDraftsRequest = z.infer<typeof saveDraftsRequestSchema>
export type ImportMessagesRequest = z.infer<typeof importMessagesRequestSchema>
export type LoadImportedRequest = z.infer<typeof loadImportedRequestSchema>
export type DiscardImportRequest = z.infer<typeof discardImportRequestSchema>
export type FileResult = { cancelled: boolean; fileName?: string; count?: number }
export type ImportEntry = {
	id: string
	fileName: string
	index: number
	messageId: string | null
	bodySize: number
	fullIssue: string | null
	bodyIssue: string | null
	warnings?: string[]
}
export type ImportPreview = { cancelled: boolean; importId?: string; items: ImportEntry[] }
export type ImportedDrafts = { drafts: z.infer<typeof draftSchema>[] }
