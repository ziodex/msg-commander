import type { RelayConfigPreview, RelayConfigResult } from '@shared/contracts/relay/configuration'
import {
	relayNamespace,
	type RelayConnection,
	type RelayDetails,
	type RelayOutcome,
	type RelayPage,
	type RelayScope,
} from '@shared/contracts/relay/core'
import { computed, ref } from 'vue'
export function createRelayState() {
	const connection = ref<RelayConnection>(),
		busy = ref(''),
		operationId = ref(''),
		error = ref('')
	const hybrid = ref<RelayPage>({ items: [], continuationToken: null }),
		wcf = ref<RelayPage>({ items: [], continuationToken: null })
	const selected = ref<RelayScope>({ ...relayNamespace }),
		details = ref<RelayDetails>(),
		policies = ref<RelayPage>({ items: [], continuationToken: null })
	const outcome = ref<RelayOutcome>(),
		reviewed = ref(false)
	const configPreview = ref<RelayConfigPreview>(),
		configFileName = ref(''),
		configOutcome = ref<RelayConfigResult>(),
		configReviewed = ref(false)
	const blocked = computed(
		() =>
			!!busy.value ||
			(outcome.value?.status === 'unknown' && !reviewed.value) ||
			(configOutcome.value?.status === 'unknown' && !configReviewed.value),
	)
	const lifetime = { generation: 0 }

	return {
		connection,
		busy,
		operationId,
		error,
		hybrid,
		wcf,
		selected,
		details,
		policies,
		outcome,
		reviewed,
		configPreview,
		configFileName,
		configOutcome,
		configReviewed,
		blocked,
		lifetime,
	}
}
export type RelayState = ReturnType<typeof createRelayState>
