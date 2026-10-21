<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { useHybrid } from '@/features/relay/stores/hybrid'
import { useWorkspace } from '@/shared/workspace/store'
import {
	hybridRunSchema,
	type HybridRun,
	type HybridExchange,
} from '@shared/contracts/relay/hybrid'
import type { Profile } from '@shared/contracts'
import { decodeBase64, utf8Preview, prettyJson, hexPreview } from '@/shared/lib/message-body'
import JsonBody from '../../../shared/components/JsonBody.vue'
const props = defineProps<{ profile: Profile; name?: string }>(),
	emit = defineEmits<{ close: [] }>()
const hybrid = useHybrid(),
	workspace = useWorkspace()
const form = reactive({
	name: props.name ?? '',
	mode: 'http-send' as HybridRun['mode'],
	method: 'POST' as HybridRun['method'],
	body: '{"message":"Hello from Msg Commander"}',
	encoding: 'utf8' as HybridRun['encoding'],
	responseStatus: 200,
	maxCount: 1,
	maxSeconds: 60,
	exchangeSeconds: 15,
})
const headerText = ref('Content-Type: application/json'),
	acknowledged = ref(false),
	error = ref(''),
	inspection = ref<HybridExchange>(),
	side = ref<'request' | 'response'>('response'),
	format = ref<'auto' | 'hex' | 'base64'>('auto'),
	clearReview = ref(false)
const listening = computed(() => form.mode.endsWith('listen')),
	streaming = computed(() => form.mode.startsWith('stream'))
const entries = computed(() =>
	hybrid.entries.filter((e) => e.request.profileId === props.profile.id),
)
const tab = ref<'setup' | 'jobs'>(!props.name && entries.value.length ? 'jobs' : 'setup')
const blocked = computed(
	() =>
		!workspace.ready ||
		hybrid.blocked(listening.value ? 'listen' : 'send') ||
		hybrid.entries.length >= 20,
)
watch(
	() => form.mode,
	() => {
		form.maxCount = listening.value ? 10 : 1
		headerText.value = streaming.value ? '' : 'Content-Type: application/json'
	},
)
watch(
	[() => ({ ...form }), headerText],
	() => {
		acknowledged.value = false
		error.value = ''
	},
	{ deep: true },
)
const inspectedBody = computed(
	() => inspection.value?.[side.value === 'request' ? 'requestBody' : 'responseBody'] ?? '',
)
const bytes = computed(() => decodeBase64(inspectedBody.value)),
	text = computed(() => utf8Preview(bytes.value, true)),
	json = computed(() => (text.value === null ? null : prettyJson(text.value)))
function inspect(item: HybridExchange) {
	inspection.value = item
	side.value = 'response'
	format.value = 'auto'
}
function clearHistory() {
	clearReview.value = false
	void hybrid.clear()
}
async function run() {
	const headers = headerText.value
		.split('\n')
		.filter((l) => l.trim())
		.map((line) => {
			const i = line.indexOf(':')
			return {
				name: i < 0 ? '' : line.slice(0, i).trim(),
				value: i < 0 ? '' : line.slice(i + 1).trim(),
			}
		})
	const parsed = hybridRunSchema.safeParse({
		...form,
		headers,
		id: crypto.randomUUID(),
		profileId: props.profile.id,
		acknowledged: acknowledged.value,
	})
	if (!parsed.success) {
		error.value = parsed.error.issues[0]?.message ?? 'Check the test settings.'
		return
	}
	const { id: _id, ...setup } = parsed.data
	acknowledged.value = false
	tab.value = 'jobs'
	await hybrid.run(setup)
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && emit('close')">
		<DialogContent class="hybrid-dialog" @interact-outside.prevent>
			<DialogHeader
				><DialogTitle>Test Hybrid Connection</DialogTitle
				><DialogDescription
					>{{ profile.namespace }} ·
					{{
						profile.auth === 'sas'
							? 'SAS Send / Listen access'
							: 'Microsoft Entra Relay Sender / Listener access'
					}}</DialogDescription
				></DialogHeader
			>
			<div class="relay-actions" role="tablist" aria-label="Hybrid Connection testing views">
				<Button
					role="tab"
					:aria-selected="tab === 'setup'"
					:variant="tab === 'setup' ? 'default' : 'outline'"
					@click="tab = 'setup'"
					>Configure test</Button
				>
				<Button
					role="tab"
					:aria-selected="tab === 'jobs'"
					:variant="tab === 'jobs' ? 'default' : 'outline'"
					@click="tab = 'jobs'"
					>Test jobs ({{ entries.length }})</Button
				>
			</div>
			<div class="hybrid-scroll">
				<p class="field-hint">
					Use a known Hybrid Connection name. Management access is optional. One sender
					and one listener can run together; closing this window keeps jobs running.
				</p>
				<form v-if="tab === 'setup'" class="hybrid-form" @submit.prevent="run">
					<div class="hybrid-grid">
						<label
							>Hybrid Connection name<Input
								v-model="form.name"
								placeholder="team/bridge" /></label
						><label
							>Test mode<select v-model="form.mode" aria-label="Test mode">
								<option value="http-send">HTTP request</option>
								<option value="http-listen">HTTP listener</option>
								<option value="stream-send">Stream sender</option>
								<option value="stream-listen">Stream listener</option>
							</select></label
						>
					</div>
					<p v-if="streaming" class="form-warning">
						Raw byte stream: the sender writes the body and half-closes its output. The
						listener reads to EOF, replies with its configured body and closes. Peers
						must follow this exchange pattern. Interactive or newline-based protocols
						may time out.
					</p>
					<p v-else-if="listening" class="field-hint">
						Reply to incoming requests with a fixed status, headers and body. One
						exchange is handled at a time; additional simultaneous clients receive 503.
						Other listeners on this entity may receive requests instead.
					</p>
					<div class="hybrid-grid">
						<label v-if="!streaming && !listening"
							>HTTP method<select v-model="form.method" aria-label="HTTP method">
								<option
									v-for="method in [
										'GET',
										'POST',
										'PUT',
										'PATCH',
										'DELETE',
										'HEAD',
										'OPTIONS',
									]"
									:key="method"
								>
									{{ method }}
								</option>
							</select></label
						><label v-if="!streaming && listening"
							>Response status<Input
								v-model.number="form.responseStatus"
								type="number"
								min="200"
								max="599" /></label
						><label
							>Body encoding<select
								v-model="form.encoding"
								aria-label="Body encoding"
							>
								<option value="utf8">UTF-8</option>
								<option value="base64">Base64 (binary)</option>
							</select></label
						>
					</div>
					<label
						>{{ listening ? 'Response body' : 'Request body'
						}}<textarea v-model="form.body" rows="4" spellcheck="false" />
					</label>
					<p class="field-hint">
						Maximum 16 KiB per body. GET, HEAD, 204 and 304 require an empty configured
						body. Payloads stay in session memory.
					</p>
					<label v-if="!streaming"
						>{{ listening ? 'Response headers' : 'Request headers'
						}}<textarea
							v-model="headerText"
							rows="2"
							placeholder="Content-Type: application/json"
							spellcheck="false"
						/>
					</label>
					<div class="hybrid-grid three">
						<label
							>Maximum exchanges<Input
								v-model.number="form.maxCount"
								type="number"
								min="1"
								max="100" /></label
						><label
							>Job time limit (seconds)<Input
								v-model.number="form.maxSeconds"
								type="number"
								min="1"
								max="600" /></label
						><label
							>Exchange timeout (seconds)<Input
								v-model.number="form.exchangeSeconds"
								type="number"
								min="1"
								max="60"
						/></label>
					</div>
					<p class="field-hint">
						Up to 100 exchanges and 10 minutes. Captures stop when the inspection buffer
						fills. The stream connection handshake and cleanup can take up to 10 seconds
						each. Payloads are never automatically retried.
					</p>
					<label class="hybrid-check"
						><input v-model="acknowledged" type="checkbox" />I reviewed the endpoint and
						limits and want to
						{{
							listening
								? 'accept clients and send these responses'
								: 'send these requests to the peer'
						}}.</label
					>
					<p v-if="error" class="form-error" role="alert">{{ error }}</p>
					<Button type="submit" :disabled="!acknowledged || blocked">{{
						listening ? 'Start listener' : 'Send test'
					}}</Button>
					<p v-if="blocked" class="field-hint">
						Finish the active job of this type, review an uncertain result, or clear
						history before starting another test. Cleanup warnings require a backend
						restart.
					</p>
				</form>
				<section
					v-if="tab === 'jobs'"
					aria-label="Hybrid Connection jobs"
					class="hybrid-jobs"
				>
					<h3>
						Test jobs <small>{{ entries.length }} / 20 retained</small>
					</h3>
					<p v-if="!entries.length" class="field-hint">
						No test jobs for this profile yet.
					</p>
					<article v-for="entry in entries" :key="entry.id" class="hybrid-job">
						<div class="relay-heading">
							<strong>{{ entry.request.name }} · {{ entry.request.mode }}</strong
							><Button
								v-if="entry.running"
								size="sm"
								variant="outline"
								@click="workspace.cancel(entry.id)"
								>Stop test</Button
							>
						</div>
						<p v-if="entry.running" role="status">
							{{ entry.progress?.count ?? 0 }} /
							{{ entry.request.maxCount }} exchanges ·
							{{ entry.progress?.phase ?? 'connecting' }}
						</p>
						<p v-if="entry.result" role="status">
							{{ entry.result.status }} · {{ entry.result.summary }}
						</p>
						<p v-if="entry.error" class="form-error" role="alert">{{ entry.error }}</p>
						<p v-if="entry.result?.cleanupWarning" class="form-warning">
							{{ entry.result.cleanupWarning }}
						</p>
						<Button
							v-if="entry.interrupted"
							variant="outline"
							size="sm"
							@click="hybrid.recover(entry)"
							>Recover test result</Button
						>
						<label
							v-if="entry.interrupted || entry.result?.status === 'unknown'"
							class="hybrid-check"
							><input v-model="entry.reviewed" type="checkbox" />I reviewed the
							uncertain exchange and will check the peer before sending again.</label
						>
						<div v-if="entry.result?.exchanges.length" class="hybrid-table">
							<table>
								<thead>
									<tr>
										<th>Exchange</th>
										<th>Method</th>
										<th>Status</th>
										<th>Request / response bytes</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="item in entry.result.exchanges" :key="item.number">
										<td>{{ item.number }}</td>
										<td>{{ item.method }}</td>
										<td>{{ item.statusCode ?? item.outcome }}</td>
										<td>
											{{ decodeBase64(item.requestBody).length }} /
											{{ decodeBase64(item.responseBody).length }}
										</td>
										<td>
											<Button
												variant="ghost"
												size="sm"
												:aria-label="`Inspect exchange ${item.number}`"
												@click="inspect(item)"
												>Inspect</Button
											>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</article>
				</section>
				<label v-if="tab === 'jobs' && hybrid.entries.length" class="hybrid-check"
					><input v-model="clearReview" type="checkbox" />Stop all Hybrid Connection jobs
					and clear their captured history across profiles.</label
				>
				<Button
					v-if="tab === 'jobs' && hybrid.entries.length"
					variant="outline"
					:disabled="!clearReview"
					@click="clearHistory"
					>Clear testing history</Button
				>
			</div>
			<div class="relay-actions">
				<Button variant="outline" @click="emit('close')">Close testing</Button>
			</div>
		</DialogContent>
	</Dialog>
	<Dialog :open="!!inspection" @update:open="!$event && (inspection = undefined)">
		<DialogContent class="hybrid-dialog hybrid-inspector"
			><DialogHeader
				><DialogTitle>Inspect Relay exchange {{ inspection?.number }}</DialogTitle
				><DialogDescription
					>{{ inspection?.method }} ·
					{{ inspection?.statusCode ?? inspection?.outcome }} ·
					{{ inspection?.at }}</DialogDescription
				></DialogHeader
			>
			<div v-if="inspection" class="hybrid-scroll">
				<p>{{ inspection.summary }}</p>
				<div class="relay-actions">
					<Button
						v-for="value in ['request', 'response'] as const"
						:key="value"
						:variant="side === value ? 'default' : 'outline'"
						@click="side = value"
						>{{ value === 'request' ? 'Request' : 'Response' }}</Button
					><label
						>View<select v-model="format" aria-label="View">
							<option value="auto">JSON / text</option>
							<option value="hex">Hex</option>
							<option value="base64">Base64</option>
						</select></label
					>
				</div>
				<p
					v-if="inspection[side === 'request' ? 'requestTruncated' : 'responseTruncated']"
					class="form-warning"
				>
					Only the first 16 KiB was captured; the body is truncated.
				</p>
				<dl class="hybrid-headers">
					<template
						v-for="header in inspection[
							side === 'request' ? 'requestHeaders' : 'responseHeaders'
						]"
						:key="header.name"
						><dt>{{ header.name }}</dt>
						<dd>{{ header.value }}</dd></template
					>
				</dl>
				<JsonBody v-if="format === 'auto' && json !== null" :text="json" />
				<pre v-else class="body-preview">{{
					format === 'base64'
						? inspectedBody
						: format === 'hex' || text === null
							? hexPreview(bytes)
							: text || '(empty body)'
				}}</pre>
				<p class="field-hint">
					{{ bytes.length }} captured bytes. Authentication, cookies and transport headers
					are omitted; header capture is bounded.
				</p>
			</div>
			<Button variant="outline" @click="inspection = undefined">Close exchange</Button>
		</DialogContent>
	</Dialog>
</template>
<style>
.hybrid-dialog {
	width: min(960px, calc(100vw - 40px));
	max-width: 960px;
	max-height: calc(100vh - 40px);
	display: flex;
	flex-direction: column;
}
.hybrid-scroll {
	overflow: auto;
	min-height: 0;
	padding: 2px 4px;
}
.hybrid-form {
	display: grid;
	gap: 12px;
	margin: 16px 0 24px;
}
.hybrid-form label {
	display: grid;
	gap: 6px;
	font-size: 13px;
}
.hybrid-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 14px;
}
.hybrid-grid.three {
	grid-template-columns: repeat(3, 1fr);
}
.hybrid-dialog textarea,
.hybrid-dialog select {
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--background);
	color: var(--foreground);
	padding: 8px;
	width: 100%;
}
.hybrid-dialog textarea {
	font-family: var(--font-mono, monospace);
	resize: vertical;
}
.hybrid-check {
	display: flex !important;
	align-items: flex-start;
	gap: 8px !important;
	font-size: 13px;
	margin: 8px 0;
}
.hybrid-check input {
	margin-top: 3px;
}
.hybrid-job {
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 12px;
	margin: 12px 0;
}
.hybrid-job p {
	font-size: 13px;
	margin: 8px 0;
}
.hybrid-table {
	overflow: auto;
}
.hybrid-dialog table {
	width: 100%;
	font-size: 12px;
	text-align: left;
}
.hybrid-dialog td,
.hybrid-dialog th {
	padding: 6px;
	border-bottom: 1px solid var(--border);
}
.hybrid-headers {
	display: grid;
	grid-template-columns: 160px 1fr;
	gap: 6px;
	font-size: 12px;
	margin: 12px 0;
	overflow-wrap: anywhere;
}
.hybrid-inspector .body-preview {
	max-height: 50vh;
	overflow: auto;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
@media (max-width: 700px) {
	.hybrid-grid,
	.hybrid-grid.three {
		grid-template-columns: 1fr;
	}
}
</style>
