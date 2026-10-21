import {
	type TestJobRequest,
	type TestPayloadPreview,
	type TestJobResultRequest,
	testJobResultSchema,
	testPayloadResultSchema,
} from './test-jobs'
import {
	type PreviewEntityCopyRequest,
	type ExecuteEntityCopyRequest,
	type EntityCopyResultRequest,
	type FinishEntityRenameRequest,
	entityCopyPreviewSchema,
	entityCopyResultSchema,
	entityRenameReviewSchema,
} from '../../entity-copy'
import {
	type ConnectAuthorizationRequest,
	type ListAuthorizationRequest,
	type GetAuthorizationRequest,
	type GetAuthorizationKeyRequest,
	type CreateAuthorizationRequest,
	type UpdateAuthorizationRequest,
	type DeleteAuthorizationRequest,
	type RegenerateAuthorizationRequest,
	authorizationSessionSchema,
	authorizationPageSchema,
	authorizationRuleSchema,
	authorizationKeySchema,
} from '../../authorization'
import {
	type BulkEntityPreviewRequest,
	type BulkEntityExecuteRequest,
	type BulkEntityResultRequest,
	bulkEntityPlanSchema,
	bulkEntityResultSchema,
} from '../../bulk-entities'
import {
	type BulkPurgePreviewRequest,
	type BulkPurgeRequest,
	type BulkPurgeResultRequest,
	type ReceiveDeleteRequest,
	type ReceiveDeleteResultRequest,
	type PurgeRequest,
	type ResendRequest,
	type ResendResultRequest,
	type PurgeResultRequest,
	bulkPurgePlanSchema,
	bulkPurgeResultSchema,
	receiveDeleteResultSchema,
	purgeResultSchema,
	resendResultSchema,
} from './maintenance/index'
import {
	type ListenerStart,
	type ListenerStatusRequest,
	type ListenerRequest,
	type ListenerSettle,
	listenerStateSchema,
} from '../../listeners'
import { type ProfileInput } from '../platform/profiles'
import {
	type ListSessionsRequest,
	type CloseSessionScanRequest,
	type AcceptSessionRequest,
	type SessionRequest,
	type SetSessionStateRequest,
	sessionPageSchema,
	sessionStateSchema,
} from '../../sessions'
import {
	type MessageDraft,
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
	outcomeSchema,
	deliveriesSchema,
} from '../../message-operations'
import {
	type ListRulesRequest,
	type RuleRequest,
	type CreateRuleRequest,
	type UpdateRuleRequest,
	type DeleteRuleRequest,
	rulePageSchema,
	ruleConfigurationSchema,
} from '../../rules'
import {
	type EntityConfigurationRequest,
	type CreateEntityRequest,
	type UpdateEntityRequest,
	type DeleteEntityRequest,
	entityConfigurationSchema,
} from '../../entity-management'
import {
	type DeferredReferencesRequest,
	type ForgetDeferredRequest,
	deferredReferencesSchema,
} from '../../deferred-messages'
import {
	type ListRequest,
	type EntityRequest,
	type PeekRequest,
	type InspectRequest,
	type BodyRequest,
	peekPageSchema,
	connectionSchema,
	runtimePageSchema,
	entityPageSchema,
	entityDetailsSchema,
	messageDetailsSchema,
	bodyChunkSchema,
} from '../../service-bus'
import { z } from 'zod'

export type ServiceBusBackendParams = {
	'sb.test.run': TestJobRequest
	'test.payload.preview': TestPayloadPreview
	'sb.test.result': TestJobResultRequest
	'sb.entity.copy.preview': PreviewEntityCopyRequest
	'sb.entity.copy.execute': ExecuteEntityCopyRequest
	'sb.entity.copy.result': EntityCopyResultRequest
	'sb.entity.rename.review': EntityCopyResultRequest
	'sb.entity.rename.finish': FinishEntityRenameRequest
	'sb.entity.rename.result': EntityCopyResultRequest
	'sb.authorization.connect': ConnectAuthorizationRequest
	'sb.authorization.list': ListAuthorizationRequest
	'sb.authorization.get': GetAuthorizationRequest
	'sb.authorization.key': GetAuthorizationKeyRequest
	'sb.authorization.create': CreateAuthorizationRequest
	'sb.authorization.update': UpdateAuthorizationRequest
	'sb.authorization.delete': DeleteAuthorizationRequest
	'sb.authorization.regenerate': RegenerateAuthorizationRequest
	'sb.entity.bulk.preview': BulkEntityPreviewRequest
	'sb.entity.bulk.execute': BulkEntityExecuteRequest
	'sb.entity.bulk.result': BulkEntityResultRequest
	'sb.purge.bulk.preview': BulkPurgePreviewRequest
	'sb.purge.bulk': BulkPurgeRequest
	'sb.purge.bulk.result': BulkPurgeResultRequest
	'sb.receive-delete': ReceiveDeleteRequest
	'sb.receive-delete.result': ReceiveDeleteResultRequest
	'sb.purge': PurgeRequest
	'sb.listener.start': ListenerStart
	'sb.listener.status': ListenerStatusRequest
	'sb.listener.stop': ListenerRequest
	'sb.listener.settle': ListenerSettle
	'sb.deadletters.resend': ResendRequest & { destinationProfile?: ProfileInput }
	'sb.deadletters.result': ResendResultRequest
	'sb.purge.result': PurgeResultRequest
	'sb.sessions': ListSessionsRequest
	'sb.sessions.close': CloseSessionScanRequest
	'sb.session.accept': AcceptSessionRequest
	'sb.session.release': SessionRequest
	'sb.session.state': SessionRequest
	'sb.session.state.set': SetSessionStateRequest
	'sb.session.renew': SessionRequest
	'messages.validate': { drafts: MessageDraft[] }
	'sb.rules': ListRulesRequest
	'sb.rule': RuleRequest
	'sb.rule.create': CreateRuleRequest
	'sb.rule.update': UpdateRuleRequest
	'sb.rule.delete': DeleteRuleRequest
	'sb.entity-config': EntityConfigurationRequest
	'sb.entity.create': CreateEntityRequest
	'sb.entity.update': UpdateEntityRequest
	'sb.entity.delete': DeleteEntityRequest
	'sb.send.batch': BatchRequest
	'sb.scheduled': ScheduledRequest
	'sb.scheduled.cancel': CancelScheduledRequest
	'sb.snapshot.resend': ResendSnapshotRequest
	'sb.send': SendRequest
	'sb.receive': ReceiveRequest
	'sb.defer.list': DeferredReferencesRequest
	'sb.defer.forget': ForgetDeferredRequest
	'sb.deliveries': DeliveriesRequest
	'sb.close-receiver': DeliveriesRequest
	'sb.settle': SettleRequest
	'sb.replay': ReplayRequest
	'sb.outcome': OutcomeRequest
	'sb.reset': Record<string, never>
	'sb.connect': { operationId: string; profile: ProfileInput }
	'sb.disconnect': { connectionId: string }
	'sb.runtime': ListRequest
	'sb.list': ListRequest
	'sb.entity': EntityRequest
	'sb.peek': PeekRequest
	'sb.inspect': InspectRequest
	'sb.body': BodyRequest
}

export const serviceBusBackendResults = {
	'sb.entity.copy.preview': entityCopyPreviewSchema,
	'sb.entity.copy.execute': entityCopyResultSchema,
	'sb.entity.copy.result': entityCopyResultSchema.nullable(),
	'sb.entity.rename.review': entityRenameReviewSchema,
	'sb.entity.rename.finish': outcomeSchema,
	'sb.entity.rename.result': outcomeSchema.nullable(),
	'sb.authorization.connect': authorizationSessionSchema,
	'sb.authorization.list': authorizationPageSchema,
	'sb.authorization.get': authorizationRuleSchema,
	'sb.authorization.key': authorizationKeySchema,
	'sb.authorization.create': outcomeSchema,
	'sb.authorization.update': outcomeSchema,
	'sb.authorization.delete': outcomeSchema,
	'sb.authorization.regenerate': outcomeSchema,
	'sb.entity.bulk.preview': bulkEntityPlanSchema,
	'sb.entity.bulk.execute': bulkEntityResultSchema,
	'sb.entity.bulk.result': bulkEntityResultSchema.nullable(),
	'sb.purge.bulk.preview': bulkPurgePlanSchema,
	'sb.purge.bulk': bulkPurgeResultSchema,
	'sb.purge.bulk.result': bulkPurgeResultSchema.nullable(),
	'sb.test.run': testJobResultSchema,
	'test.payload.preview': testPayloadResultSchema,
	'sb.test.result': testJobResultSchema.nullable(),
	'sb.receive-delete': receiveDeleteResultSchema,
	'sb.receive-delete.result': receiveDeleteResultSchema.nullable(),
	'sb.purge': purgeResultSchema,
	'sb.listener.start': listenerStateSchema,
	'sb.listener.status': listenerStateSchema.nullable(),
	'sb.listener.stop': listenerStateSchema,
	'sb.listener.settle': listenerStateSchema,
	'sb.deadletters.resend': resendResultSchema,
	'sb.deadletters.result': resendResultSchema.nullable(),
	'sb.purge.result': purgeResultSchema.nullable(),
	'sb.sessions': sessionPageSchema,
	'sb.sessions.close': z.null(),
	'sb.session.accept': deliveriesSchema,
	'sb.session.release': z.null(),
	'sb.session.state': sessionStateSchema,
	'sb.session.state.set': outcomeSchema,
	'sb.session.renew': outcomeSchema,
	'messages.validate': z.null(),
	'sb.rules': rulePageSchema,
	'sb.rule': ruleConfigurationSchema,
	'sb.rule.create': outcomeSchema,
	'sb.rule.update': outcomeSchema,
	'sb.rule.delete': outcomeSchema,
	'sb.entity-config': entityConfigurationSchema,
	'sb.entity.create': outcomeSchema,
	'sb.entity.update': outcomeSchema,
	'sb.entity.delete': outcomeSchema,
	'sb.send.batch': outcomeSchema,
	'sb.scheduled': peekPageSchema,
	'sb.scheduled.cancel': outcomeSchema,
	'sb.snapshot.resend': outcomeSchema,
	'sb.send': outcomeSchema,
	'sb.receive': deliveriesSchema,
	'sb.defer.list': deferredReferencesSchema,
	'sb.defer.forget': z.boolean(),
	'sb.deliveries': deliveriesSchema,
	'sb.close-receiver': z.null(),
	'sb.settle': outcomeSchema,
	'sb.replay': outcomeSchema,
	'sb.outcome': outcomeSchema.nullable(),
	'sb.reset': z.null(),
	'sb.connect': connectionSchema,
	'sb.disconnect': z.null(),
	'sb.runtime': runtimePageSchema,
	'sb.list': entityPageSchema,
	'sb.entity': entityDetailsSchema,
	'sb.peek': peekPageSchema,
	'sb.inspect': messageDetailsSchema,
	'sb.body': bodyChunkSchema,
}
