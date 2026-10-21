<script setup lang="ts">
import ActionConfirmation from '../../../shared/components/ActionConfirmation.vue'
import { computed, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import {
	defaultRule,
	emptyCorrelation,
	ruleDefinitionSchema,
	rulePath,
	type SubscriptionTarget,
	type RuleConfiguration,
	type RuleDefinition,
	type RulePage,
} from '@shared/rules'
import type { OperationOutcome } from '@shared/message-operations'
import { useServiceBus } from '@/features/service-bus/stores/service-bus'
import { useWorkspace } from '@/shared/workspace/store'
import RulePropertyEditor from './RulePropertyEditor.vue'
const props = defineProps<{ target: SubscriptionTarget }>()
const sb = useServiceBus(),
	workspace = useWorkspace()
const open = ref(false),
	mode = ref<'create' | 'update' | 'delete'>()
const page = ref<RulePage>(),
	token = ref<string | null>(null),
	history = ref<(string | null)[]>([])
const name = ref(''),
	definition = ref<RuleDefinition>(defaultRule()),
	current = ref<RuleConfiguration>()
const confirmation = ref(''),
	validation = ref(''),
	receipt = ref<OperationOutcome>()
const frozen = computed(() => !!sb.busy || receipt.value?.status === 'unknown')
const correlationFields = [
	['correlationId', 'Correlation ID'],
	['messageId', 'Message ID'],
	['subject', 'Subject'],
	['contentType', 'Content type'],
	['to', 'To'],
	['replyTo', 'Reply to'],
	['sessionId', 'Session ID'],
	['replyToSessionId', 'Reply-to session ID'],
] as const
function resetForm() {
	mode.value = undefined
	current.value = undefined
	confirmation.value = ''
	validation.value = ''
	receipt.value = undefined
}
function close(value = false) {
	if (!sb.busy) {
		open.value = value
		if (!value) resetForm()
	}
}
async function load(next: string | null = null, direction: 'reset' | 'next' | 'back' = 'reset') {
	const result = await sb.listRules(props.target, next)
	if (!result) return
	if (direction === 'next') history.value.push(token.value)
	else if (direction === 'back') history.value.pop()
	else history.value = []
	token.value = next
	page.value = result
}
async function show() {
	open.value = true
	resetForm()
	page.value = undefined
	await load()
}
function create() {
	resetForm()
	name.value = ''
	definition.value = defaultRule()
	mode.value = 'create'
}
async function edit(ruleName: string, action: 'update' | 'delete') {
	const result = await sb.getRule(props.target, ruleName)
	if (!result) return
	resetForm()
	current.value = result
	name.value = result.name
	definition.value = structuredClone(result.definition)
	mode.value = action
}
async function reload() {
	const result = await sb.getRule(props.target, name.value)
	if (result) {
		current.value = result
		definition.value = structuredClone(result.definition)
		confirmation.value = ''
		validation.value = ''
		receipt.value = undefined
	}
}
function changeType(event: Event) {
	const type = (event.target as HTMLSelectElement).value as RuleDefinition['filterType']
	definition.value.filterType = type
	definition.value.sqlExpression = type === 'sql' ? "user.color = 'blue'" : ''
	definition.value.filterParameters = []
	definition.value.correlation = type === 'correlation' ? emptyCorrelation() : null
}
function header(key: (typeof correlationFields)[number][0], value: string | number) {
	if (definition.value.correlation)
		definition.value.correlation[key] = value === '' ? null : String(value)
}
async function success() {
	resetForm()
	await load()
}
async function submit() {
	if (!mode.value || frozen.value || (mode.value === 'update' && current.value?.readOnlyReason))
		return
	validation.value = ''
	if (mode.value !== 'delete') {
		const parsed = ruleDefinitionSchema.safeParse(definition.value)
		if (!parsed.success) {
			validation.value = parsed.error.issues
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join(' ')
			return
		}
	}
	receipt.value = await sb.manageRule(
		mode.value,
		props.target,
		name.value,
		definition.value,
		current.value?.revision ?? '',
		confirmation.value,
	)
	if (receipt.value?.status === 'confirmed') await success()
}
async function check() {
	await sb.checkOutcome()
	receipt.value = sb.outcome
	if (receipt.value?.status === 'confirmed') await success()
}
function cancelOperation() {
	const job = workspace.jobs.find((j) => j.status === 'running' && j.label === sb.busy)
	if (job) void workspace.cancel(job.id)
}
watch(
	() => [sb.connection?.connectionId, props.target.topicName, props.target.name],
	() => {
		open.value = false
		page.value = undefined
		resetForm()
	},
)
</script>
<template>
	<div class="explorer-actions rule-management">
		<Button variant="outline" :disabled="!!sb.busy" @click="show"
			>Manage subscription rules</Button
		>
		<span class="explorer-note"
			>Filters and actions control new deliveries to this subscription.</span
		>
	</div>
	<Dialog :open="open" @update:open="close">
		<DialogContent
			class="message-dialog entity-dialog rule-dialog"
			@escape-key-down="sb.busy && $event.preventDefault()"
			@interact-outside="sb.busy && $event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>Subscription rules</DialogTitle
				><DialogDescription
					>Review filters and actions before changing which messages reach this
					subscription.</DialogDescription
				></DialogHeader
			>
			<div class="write-destination">
				<strong>{{ sb.connection?.namespace }}</strong
				><span>{{ target.topicName }} / Subscriptions / {{ target.name }}</span>
			</div>
			<p class="inspector-warning">
				A match-all rule, including an unchanged $Default, continues to accept every
				message. Creating another rule does not remove it. Each matching rule with an action
				can produce an additional copy.
			</p>
			<p class="explorer-note">
				Rules inspect message properties, not bodies. Changes affect future routing; stored
				messages are retained. SQL syntax and namespace limits are checked by Azure.
			</p>
			<template v-if="!mode">
				<div class="explorer-actions">
					<Button :disabled="!!sb.busy" @click="create">Create rule</Button
					><Button variant="outline" :disabled="!!sb.busy" @click="load()"
						>Refresh rules</Button
					>
				</div>
				<div class="message-table-wrap">
					<table class="message-table" aria-label="Subscription rules">
						<thead>
							<tr>
								<th>Rule</th>
								<th>Filter</th>
								<th>Action</th>
								<th>Manage</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="rule in page?.items" :key="rule.name">
								<td class="mono">{{ rule.name }}</td>
								<td>
									{{
										rule.filterType === 'true'
											? 'True · match all'
											: rule.filterType === 'false'
												? 'False · match none'
												: rule.filterType
									}}
								</td>
								<td>{{ rule.hasAction ? 'SQL action' : 'None' }}</td>
								<td class="explorer-actions">
									<Button
										size="sm"
										variant="outline"
										:aria-label="`Edit rule ${rule.name}`"
										:disabled="!!sb.busy"
										@click="edit(rule.name, 'update')"
										>Edit</Button
									><Button
										size="sm"
										variant="outline"
										:aria-label="`Delete rule ${rule.name}`"
										:disabled="!!sb.busy"
										@click="edit(rule.name, 'delete')"
										>Delete</Button
									>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<p v-if="page && !page.items.length" class="explorer-note">
					No rules on this page. A subscription with no matching rules receives no new
					messages.
				</p>
				<div class="explorer-actions">
					<span v-if="page" class="explorer-note"
						>{{ page.items.length }} rules loaded · page {{ history.length + 1 }}</span
					><Button
						size="sm"
						variant="outline"
						:disabled="!!sb.busy || !history.length"
						@click="load(history[history.length - 1], 'back')"
						>Previous rules</Button
					><Button
						size="sm"
						variant="outline"
						:disabled="!!sb.busy || !page?.continuationToken"
						@click="load(page?.continuationToken ?? null, 'next')"
						>Next rules</Button
					>
				</div>
			</template>
			<form v-else class="composer-form" @submit.prevent="submit">
				<h3>
					{{
						mode === 'create'
							? 'Create rule'
							: mode === 'delete'
								? 'Delete rule'
								: 'Edit rule'
					}}
				</h3>
				<fieldset :disabled="frozen || (mode === 'update' && !!current?.readOnlyReason)">
					<label
						>Rule name<Input
							v-model="name"
							aria-label="Rule name"
							:readonly="mode !== 'create'"
							maxlength="50"
							required
					/></label>
					<template v-if="mode === 'delete'">
						<p class="inspector-warning">
							Deleting this rule cannot be undone. If no other rule matches, new
							messages will not reach this subscription. Stored messages and other
							rules are not deleted.
						</p>
						<ActionConfirmation
							v-model="confirmation"
							:expected="rulePath(target, name)"
							label="I understand this rule will be permanently deleted."
						/>
					</template>
					<template v-else>
						<label
							>Filter type<select
								:value="definition.filterType"
								class="commander-select"
								aria-label="Rule filter type"
								@change="changeType"
							>
								<option value="sql">SQL expression</option>
								<option value="correlation">Correlation</option>
								<option value="true">True · match all</option>
								<option value="false">False · match none</option>
								<option
									v-if="definition.filterType === 'unsupported'"
									value="unsupported"
								>
									Unsupported · read only
								</option>
							</select></label
						>
						<template v-if="definition.filterType === 'sql'">
							<label
								>SQL filter expression<textarea
									v-model="definition.sqlExpression"
									aria-label="SQL filter expression"
									class="commander-textarea mono"
									rows="3"
									maxlength="1024"
									spellcheck="false"
								/>
							</label>
							<RulePropertyEditor
								v-model="definition.filterParameters"
								label="Filter parameters"
							/>
						</template>
						<template v-if="definition.correlation">
							<p class="explorer-note">
								All supplied fields must match (AND). String comparisons are
								case-sensitive. Blank system fields are unconstrained.
							</p>
							<div class="composer-grid">
								<label v-for="[key, label] in correlationFields" :key="key"
									>{{ label
									}}<Input
										:model-value="definition.correlation[key] ?? ''"
										:aria-label="`Match ${label}`"
										maxlength="260"
										@update:model-value="header(key, $event)"
								/></label>
							</div>
							<RulePropertyEditor
								v-model="definition.correlation.properties"
								label="Correlation properties"
								correlation
							/>
						</template>
						<label
							>SQL action (optional)<textarea
								v-model="definition.actionExpression"
								aria-label="SQL rule action"
								class="commander-textarea mono"
								rows="3"
								maxlength="1024"
								placeholder="SET user.route = 'priority';"
								spellcheck="false"
							/>
						</label>
						<p class="explorer-note">
							An action can SET or REMOVE properties on the matching copy. Clear both
							the expression and parameters to remove an existing action.
						</p>
						<RulePropertyEditor
							v-model="definition.actionParameters"
							label="Action parameters"
						/>
					</template>
				</fieldset>
				<p v-if="current?.readOnlyReason" class="inspector-warning">
					{{ current.readOnlyReason }}
				</p>
				<p v-if="receipt" class="inspector-warning" role="status">
					{{ receipt.status }}: {{ receipt.summary
					}}<Button
						v-if="receipt.status === 'unknown'"
						type="button"
						variant="outline"
						:disabled="!!sb.busy"
						@click="check"
						>Check outcome</Button
					>
				</p>
				<div class="explorer-actions entity-form-actions">
					<Button
						type="submit"
						:variant="mode === 'delete' ? 'destructive' : 'default'"
						:disabled="
							frozen ||
							!name.trim() ||
							(mode === 'delete' && confirmation !== rulePath(target, name)) ||
							(mode === 'update' && !!current?.readOnlyReason)
						"
						>{{
							mode === 'create'
								? 'Create rule'
								: mode === 'delete'
									? 'Permanently delete rule'
									: 'Save rule'
						}}</Button
					>
					<Button
						v-if="mode !== 'create' && receipt?.status !== 'unknown'"
						type="button"
						variant="outline"
						:disabled="!!sb.busy"
						@click="reload"
						>Reload rule (discard draft)</Button
					>
					<Button type="button" variant="outline" :disabled="!!sb.busy" @click="resetForm"
						>Back to rules</Button
					>
				</div>
			</form>
			<p v-if="validation || sb.error" class="error-banner" role="alert">
				{{ validation || sb.error }}
			</p>
			<div class="explorer-actions">
				<Button variant="outline" :disabled="!!sb.busy" @click="close()">Close rules</Button
				><Button v-if="sb.busy" variant="outline" @click="cancelOperation"
					>Cancel operation</Button
				>
			</div>
		</DialogContent>
	</Dialog>
</template>
