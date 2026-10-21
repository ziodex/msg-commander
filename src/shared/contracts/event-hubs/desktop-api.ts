import {
	type EventListen,
	type EventListenResult,
	type EventListenResultRequest,
} from './listening'
import { type DesktopResult } from '../platform/desktop'
import {
	type EventExport,
	type EventSaveDrafts,
	type EventImport,
	type EventImportPreview,
	type EventLoadImport,
	type EventDiscardImport,
	type EventCheckpointLoad,
	type EventCheckpointLoadResult,
} from './files'
import { type FileResult } from '../../message-files'
import {
	type EventDraft,
	type EventHubSend,
	type EventHubSendResult,
	type EventHubSendResultRequest,
} from './sending'
import {
	type EventHubsRequest,
	type EventHubsConnection,
	type EventHubsConnect,
	type EventHubsList,
	type EventHubsPage,
	type EventHubRequest,
	type EventHubStatistics,
	type EventHubCopyUrl,
	type EventHubInfo,
	type EventHubPartitionRequest,
	type EventHubPartition,
	type EventHubRead,
	type EventHubReadResult,
	type EventHubReadResultRequest,
	type EventDetails,
} from './core'
import {
	type EventAdminContext,
	type EventAdminGet,
	type EventAdminDetails,
	type EventPolicyList,
	type EventPolicyPage,
	type EventAdminChange,
	type EventAdminOutcome,
	type EventAdminResult,
	type EventPolicyKeyRequest,
	type EventPolicyCopyRequest,
} from './administration'
import { type AuthorizationKey } from '../../authorization'
import { type IotHubConnect } from '../../iot-hub'
import { type InspectRequest, type BodyRequest, type BodyChunk } from '../../service-bus'

export interface EventHubsDesktopApi {
	listenEventHub(request: EventListen): Promise<DesktopResult<EventListenResult>>
	getEventListenerResult(
		request: EventListenResultRequest,
	): Promise<DesktopResult<EventListenResult | null>>
	exportEvents(request: EventExport): Promise<DesktopResult<FileResult>>
	saveEventDrafts(request: EventSaveDrafts): Promise<DesktopResult<FileResult>>
	importEvents(request: EventImport): Promise<DesktopResult<EventImportPreview>>
	loadImportedEvents(request: EventLoadImport): Promise<DesktopResult<{ drafts: EventDraft[] }>>
	discardImportedEvents(request: EventDiscardImport): Promise<DesktopResult<null>>
	saveEventCheckpoint(request: EventListenResultRequest): Promise<DesktopResult<FileResult>>
	loadEventCheckpoint(
		request: EventCheckpointLoad,
	): Promise<DesktopResult<EventCheckpointLoadResult>>
	getEventAdminContext(request: EventHubsRequest): Promise<DesktopResult<EventAdminContext>>
	getEventAdminResource(request: EventAdminGet): Promise<DesktopResult<EventAdminDetails>>
	listEventPolicies(request: EventPolicyList): Promise<DesktopResult<EventPolicyPage>>
	changeEventAdminResource(request: EventAdminChange): Promise<DesktopResult<EventAdminOutcome>>
	getEventAdminResult(request: EventAdminResult): Promise<DesktopResult<EventAdminOutcome | null>>
	revealEventPolicyKey(request: EventPolicyKeyRequest): Promise<DesktopResult<AuthorizationKey>>
	copyEventPolicyKey(request: EventPolicyCopyRequest): Promise<DesktopResult<null>>
	sendEventHub(request: EventHubSend): Promise<DesktopResult<EventHubSendResult>>
	getEventHubSendResult(
		request: EventHubSendResultRequest,
	): Promise<DesktopResult<EventHubSendResult | null>>
	connectIotHub(request: IotHubConnect): Promise<DesktopResult<EventHubsConnection>>
	connectEventHubs(request: EventHubsConnect): Promise<DesktopResult<EventHubsConnection>>
	disconnectEventHubs(request: EventHubsRequest): Promise<DesktopResult<null>>
	listEventHubs(request: EventHubsList): Promise<DesktopResult<EventHubsPage>>
	getEventHubStatistics(request: EventHubRequest): Promise<DesktopResult<EventHubStatistics>>
	copyEventHubUrl(request: EventHubCopyUrl): Promise<DesktopResult<null>>
	getEventHub(request: EventHubRequest): Promise<DesktopResult<EventHubInfo>>
	getEventHubPartition(
		request: EventHubPartitionRequest,
	): Promise<DesktopResult<EventHubPartition>>
	readEventHub(request: EventHubRead): Promise<DesktopResult<EventHubReadResult>>
	getEventHubReadResult(
		request: EventHubReadResultRequest,
	): Promise<DesktopResult<EventHubReadResult | null>>
	inspectEvent(request: InspectRequest): Promise<DesktopResult<EventDetails>>
	readEventBody(request: BodyRequest): Promise<DesktopResult<BodyChunk>>
}
