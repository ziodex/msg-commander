import type { MessageSubQueue, DeadLetterSubQueue } from '@shared/service-bus'
import type { Entity, EntityTarget, PeekTarget } from '@shared/service-bus'
import type { SendTarget } from '@shared/message-operations'

export type TreeContext =
	{ kind: 'queue' | 'topic' } | { entity: Entity; subQueue?: MessageSubQueue }

export type TreeAction =
	| { type: 'bulk' }
	| { type: 'test-job'; target: EntityTarget; mode: 'send' | 'receive' }
	| { type: 'create'; kind: EntityTarget['kind']; topicName?: string }
	| { type: 'refresh' | 'edit' | 'delete' | 'duplicate' | 'rename'; target: EntityTarget }
	| { type: 'send'; target: SendTarget }
	| { type: 'listen'; target: PeekTarget }
	| { type: 'resend'; target: PeekTarget; subQueue: DeadLetterSubQueue }
	| { type: 'receive-delete'; target: PeekTarget; subQueue: MessageSubQueue }
	| { type: 'purge'; target: PeekTarget; subQueue: MessageSubQueue }
	| { type: 'peek'; entity: Entity; subQueue: MessageSubQueue }
