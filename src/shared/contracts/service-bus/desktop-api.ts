import {
	type TestJobRequest,
	type TestJobResult,
	type TestPayloadPreview,
	type TestPayloadResult,
	type TestJobResultRequest,
} from './test-jobs'
import { type DesktopResult } from '../platform/desktop'
import {
	type ReceiveDeleteRequest,
	type ReceiveDeleteResult,
	type ReceiveDeleteResultRequest,
	type BulkPurgePreviewRequest,
	type BulkPurgePlan,
	type BulkPurgeRequest,
	type BulkPurgeResult,
	type BulkPurgeResultRequest,
	type PurgeRequest,
	type PurgeResult,
	type ResendRequest,
	type ResendResult,
	type ResendResultRequest,
	type PurgeResultRequest,
} from './maintenance/index'
import {
	type ListenerStart,
	type ListenerState,
	type ListenerStatusRequest,
	type ListenerRequest,
	type ListenerSettle,
} from '../../listeners'
import {
	type PreviewEntityCopyRequest,
	type EntityCopyPreview,
	type ExecuteEntityCopyRequest,
	type EntityCopyResult,
	type EntityCopyResultRequest,
	type EntityRenameReview,
	type FinishEntityRenameRequest,
} from '../../entity-copy'
import {
	type OperationOutcome,
	type Deliveries,
	type BatchRequest,
	type ScheduledRequest,
	type CancelScheduledRequest,
	type ResendSnapshotRequest,
	type SendRequest,
	type ReceiveRequest,
	type DeliveriesRequest,
	type SettleRequest,
	type ReplayRequest,
	type OutcomeRequest,
} from '../../message-operations'
import {
	type ConnectAuthorizationRequest,
	type AuthorizationSession,
	type ListAuthorizationRequest,
	type AuthorizationPage,
	type GetAuthorizationRequest,
	type AuthorizationRule,
	type GetAuthorizationKeyRequest,
	type AuthorizationKey,
	type CreateAuthorizationRequest,
	type UpdateAuthorizationRequest,
	type DeleteAuthorizationRequest,
	type RegenerateAuthorizationRequest,
	type CopyAuthorizationKeyRequest,
} from '../../authorization'
import {
	type BulkEntityPreviewRequest,
	type BulkEntityPlan,
	type BulkEntityExecuteRequest,
	type BulkEntityResult,
	type BulkEntityResultRequest,
} from '../../bulk-entities'
import {
	type FileResult,
	type ExportMessagesRequest,
	type SaveDraftsRequest,
	type ImportMessagesRequest,
	type ImportPreview,
	type LoadImportedRequest,
	type ImportedDrafts,
	type DiscardImportRequest,
} from '../../message-files'
import {
	type ListSessionsRequest,
	type SessionPage,
	type CloseSessionScanRequest,
	type AcceptSessionRequest,
	type SessionRequest,
	type SessionState,
	type SetSessionStateRequest,
} from '../../sessions'
import {
	type ListRulesRequest,
	type RulePage,
	type RuleRequest,
	type RuleConfiguration,
	type CreateRuleRequest,
	type UpdateRuleRequest,
	type DeleteRuleRequest,
} from '../../rules'
import {
	type EntityConfigurationRequest,
	type EntityConfiguration,
	type CreateEntityRequest,
	type UpdateEntityRequest,
	type DeleteEntityRequest,
} from '../../entity-management'
import {
	type PeekPage,
	type ConnectionRequest,
	type NamespaceConnection,
	type DisconnectRequest,
	type ListRequest,
	type RuntimePage,
	type EntityPage,
	type EntityRequest,
	type EntityDetails,
	type PeekRequest,
	type InspectRequest,
	type MessageDetails,
	type BodyRequest,
	type BodyChunk,
} from '../../service-bus'
import {
	type DeferredReferencesRequest,
	type DeferredReferences,
	type ForgetDeferredRequest,
} from '../../deferred-messages'

export interface ServiceBusDesktopApi {
	runTestJob(request: TestJobRequest): Promise<DesktopResult<TestJobResult>>
	previewTestPayload(request: TestPayloadPreview): Promise<DesktopResult<TestPayloadResult>>
	getTestJobResult(request: TestJobResultRequest): Promise<DesktopResult<TestJobResult | null>>
	receiveDelete(request: ReceiveDeleteRequest): Promise<DesktopResult<ReceiveDeleteResult>>
	getReceiveDeleteResult(
		request: ReceiveDeleteResultRequest,
	): Promise<DesktopResult<ReceiveDeleteResult | null>>
	startListener(request: ListenerStart): Promise<DesktopResult<ListenerState>>
	getListener(request: ListenerStatusRequest): Promise<DesktopResult<ListenerState | null>>
	stopListener(request: ListenerRequest): Promise<DesktopResult<ListenerState>>
	settleListener(request: ListenerSettle): Promise<DesktopResult<ListenerState>>
	previewEntityCopy(request: PreviewEntityCopyRequest): Promise<DesktopResult<EntityCopyPreview>>
	executeEntityCopy(request: ExecuteEntityCopyRequest): Promise<DesktopResult<EntityCopyResult>>
	getEntityCopyResult(
		request: EntityCopyResultRequest,
	): Promise<DesktopResult<EntityCopyResult | null>>
	reviewEntityRename(request: EntityCopyResultRequest): Promise<DesktopResult<EntityRenameReview>>
	finishEntityRename(request: FinishEntityRenameRequest): Promise<DesktopResult<OperationOutcome>>
	getEntityRenameResult(
		request: EntityCopyResultRequest,
	): Promise<DesktopResult<OperationOutcome | null>>
	connectAuthorization(
		request: ConnectAuthorizationRequest,
	): Promise<DesktopResult<AuthorizationSession>>
	listAuthorizationRules(
		request: ListAuthorizationRequest,
	): Promise<DesktopResult<AuthorizationPage>>
	getAuthorizationRule(
		request: GetAuthorizationRequest,
	): Promise<DesktopResult<AuthorizationRule>>
	revealAuthorizationKey(
		request: GetAuthorizationKeyRequest,
	): Promise<DesktopResult<AuthorizationKey>>
	createAuthorizationRule(
		request: CreateAuthorizationRequest,
	): Promise<DesktopResult<OperationOutcome>>
	updateAuthorizationRule(
		request: UpdateAuthorizationRequest,
	): Promise<DesktopResult<OperationOutcome>>
	deleteAuthorizationRule(
		request: DeleteAuthorizationRequest,
	): Promise<DesktopResult<OperationOutcome>>
	regenerateAuthorizationKey(
		request: RegenerateAuthorizationRequest,
	): Promise<DesktopResult<OperationOutcome>>
	copyAuthorizationKey(request: CopyAuthorizationKeyRequest): Promise<DesktopResult<null>>
	previewBulkEntities(request: BulkEntityPreviewRequest): Promise<DesktopResult<BulkEntityPlan>>
	executeBulkEntities(request: BulkEntityExecuteRequest): Promise<DesktopResult<BulkEntityResult>>
	getBulkEntityResult(
		request: BulkEntityResultRequest,
	): Promise<DesktopResult<BulkEntityResult | null>>
	previewBulkPurge(request: BulkPurgePreviewRequest): Promise<DesktopResult<BulkPurgePlan>>
	bulkPurgeMessages(request: BulkPurgeRequest): Promise<DesktopResult<BulkPurgeResult>>
	getBulkPurgeResult(
		request: BulkPurgeResultRequest,
	): Promise<DesktopResult<BulkPurgeResult | null>>
	purgeMessages(request: PurgeRequest): Promise<DesktopResult<PurgeResult>>
	resendDeadLetters(request: ResendRequest): Promise<DesktopResult<ResendResult>>
	saveResendReceipt(request: ResendResultRequest): Promise<DesktopResult<FileResult>>
	getResendResult(request: ResendResultRequest): Promise<DesktopResult<ResendResult | null>>
	getPurgeResult(request: PurgeResultRequest): Promise<DesktopResult<PurgeResult | null>>
	listSessions(request: ListSessionsRequest): Promise<DesktopResult<SessionPage>>
	closeSessionScan(request: CloseSessionScanRequest): Promise<DesktopResult<null>>
	acceptSession(request: AcceptSessionRequest): Promise<DesktopResult<Deliveries>>
	releaseSession(request: SessionRequest): Promise<DesktopResult<null>>
	getSessionState(request: SessionRequest): Promise<DesktopResult<SessionState>>
	setSessionState(request: SetSessionStateRequest): Promise<DesktopResult<OperationOutcome>>
	renewSessionLock(request: SessionRequest): Promise<DesktopResult<OperationOutcome>>
	exportMessages(request: ExportMessagesRequest): Promise<DesktopResult<FileResult>>
	saveDrafts(request: SaveDraftsRequest): Promise<DesktopResult<FileResult>>
	importMessages(request: ImportMessagesRequest): Promise<DesktopResult<ImportPreview>>
	loadImportedMessages(request: LoadImportedRequest): Promise<DesktopResult<ImportedDrafts>>
	discardImport(request: DiscardImportRequest): Promise<DesktopResult<null>>
	listRules(request: ListRulesRequest): Promise<DesktopResult<RulePage>>
	getRule(request: RuleRequest): Promise<DesktopResult<RuleConfiguration>>
	createRule(request: CreateRuleRequest): Promise<DesktopResult<OperationOutcome>>
	updateRule(request: UpdateRuleRequest): Promise<DesktopResult<OperationOutcome>>
	deleteRule(request: DeleteRuleRequest): Promise<DesktopResult<OperationOutcome>>
	getEntityConfiguration(
		request: EntityConfigurationRequest,
	): Promise<DesktopResult<EntityConfiguration>>
	createEntity(request: CreateEntityRequest): Promise<DesktopResult<OperationOutcome>>
	updateEntity(request: UpdateEntityRequest): Promise<DesktopResult<OperationOutcome>>
	deleteEntity(request: DeleteEntityRequest): Promise<DesktopResult<OperationOutcome>>
	sendBatch(request: BatchRequest): Promise<DesktopResult<OperationOutcome>>
	listScheduledMessages(request: ScheduledRequest): Promise<DesktopResult<PeekPage>>
	cancelScheduledMessages(
		request: CancelScheduledRequest,
	): Promise<DesktopResult<OperationOutcome>>
	resendSnapshot(request: ResendSnapshotRequest): Promise<DesktopResult<OperationOutcome>>
	sendMessage(request: SendRequest): Promise<DesktopResult<OperationOutcome>>
	receiveMessages(request: ReceiveRequest): Promise<DesktopResult<Deliveries>>
	listDeferredReferences(
		request: DeferredReferencesRequest,
	): Promise<DesktopResult<DeferredReferences>>
	forgetDeferredReference(request: ForgetDeferredRequest): Promise<DesktopResult<boolean>>
	listDeliveries(request: DeliveriesRequest): Promise<DesktopResult<Deliveries>>
	closeReceiver(request: DeliveriesRequest): Promise<DesktopResult<null>>
	settleMessage(request: SettleRequest): Promise<DesktopResult<OperationOutcome>>
	replayMessage(request: ReplayRequest): Promise<DesktopResult<OperationOutcome>>
	getOperationOutcome(request: OutcomeRequest): Promise<DesktopResult<OperationOutcome | null>>
	connectNamespace(request: ConnectionRequest): Promise<DesktopResult<NamespaceConnection>>
	disconnectNamespace(request: DisconnectRequest): Promise<DesktopResult<void>>
	listRuntimeCounts(request: ListRequest): Promise<DesktopResult<RuntimePage>>
	listEntities(request: ListRequest): Promise<DesktopResult<EntityPage>>
	getEntity(request: EntityRequest): Promise<DesktopResult<EntityDetails>>
	peekMessages(request: PeekRequest): Promise<DesktopResult<PeekPage>>
	inspectMessage(request: InspectRequest): Promise<DesktopResult<MessageDetails>>
	readMessageBody(request: BodyRequest): Promise<DesktopResult<BodyChunk>>
}
