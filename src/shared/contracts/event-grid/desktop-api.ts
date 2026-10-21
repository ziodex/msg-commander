import {
	type EventGridReceive,
	type EventGridPullOutcome,
	type EventGridSettle,
	type EventGridPullTarget,
	type EventGridReceived,
	type EventGridPullInspect,
	type EventGridEventInspection,
	type EventGridPullResultRequest,
} from './pulling'
import { type DesktopResult } from '../platform/desktop'
import {
	type EventGridPublish,
	type EventGridPublishOutcome,
	type EventGridPublishResultRequest,
} from './publishing'
import {
	type EventGridConnect,
	type EventGridConnection,
	type EventGridRequest,
	type EventGridList,
	type EventGridPage,
	type EventGridGet,
	type EventGridDetails,
} from './core'
import {
	type EventGridAdminDetails,
	type EventGridAdminChange,
	type EventGridAdminOutcome,
	type EventGridAdminResult,
} from './administration'

export interface EventGridDesktopApi {
	receiveEventGrid(request: EventGridReceive): Promise<DesktopResult<EventGridPullOutcome>>
	settleEventGrid(request: EventGridSettle): Promise<DesktopResult<EventGridPullOutcome>>
	listReceivedEventGrid(request: EventGridPullTarget): Promise<DesktopResult<EventGridReceived[]>>
	clearReceivedEventGrid(
		request: EventGridPullTarget,
	): Promise<DesktopResult<EventGridReceived[]>>
	inspectReceivedEventGrid(
		request: EventGridPullInspect,
	): Promise<DesktopResult<EventGridEventInspection>>
	getEventGridPullResult(
		request: EventGridPullResultRequest,
	): Promise<DesktopResult<EventGridPullOutcome | null>>
	publishEventGrid(request: EventGridPublish): Promise<DesktopResult<EventGridPublishOutcome>>
	getEventGridPublishResult(
		request: EventGridPublishResultRequest,
	): Promise<DesktopResult<EventGridPublishOutcome | null>>
	connectEventGrid(request: EventGridConnect): Promise<DesktopResult<EventGridConnection>>
	disconnectEventGrid(request: EventGridRequest): Promise<DesktopResult<null>>
	listEventGrid(request: EventGridList): Promise<DesktopResult<EventGridPage>>
	getEventGridAdmin(request: EventGridGet): Promise<DesktopResult<EventGridAdminDetails>>
	changeEventGrid(request: EventGridAdminChange): Promise<DesktopResult<EventGridAdminOutcome>>
	getEventGridAdminResult(
		request: EventGridAdminResult,
	): Promise<DesktopResult<EventGridAdminOutcome | null>>
	getEventGrid(request: EventGridGet): Promise<DesktopResult<EventGridDetails>>
}
