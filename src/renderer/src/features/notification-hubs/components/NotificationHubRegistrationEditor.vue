<script setup lang="ts">
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
import { useNotificationHubRegistrations } from '@/features/notification-hubs/stores/notification-hub-registrations'
import { nhRegistrationDraftSchema } from '@shared/contracts/notification-hubs/registrations'
import { legacyRegistrationWarning } from '@shared/contracts/notification-hubs/compatibility'
const store = useNotificationHubRegistrations()
const service = 'http://schemas.microsoft.com/netservices/2010/10/servicebus/connect'
const platforms = ['Apple', 'FcmV1', 'Windows', 'Adm', 'Baidu', 'Browser', 'Gcm', 'Fcm', 'Mpns']
const kinds = platforms.flatMap((p) => [
	p + 'RegistrationDescription',
	p + 'TemplateRegistrationDescription',
])
const kind = ref('FcmV1RegistrationDescription'),
	handle = ref(''),
	tags = ref(''),
	body = ref(''),
	templateName = ref(''),
	extraHandle = ref(''),
	expiry = ref(''),
	headers = ref(''),
	xml = ref(''),
	advanced = ref(false),
	acknowledge = ref(false),
	formError = ref('')
const browserKey = ref(''),
	browserAuth = ref('')
const originalHeaders = ref('')
const current = computed(() => store.editor!),
	mode = computed(() => current.value.action)
const prefix = computed(() =>
	kind.value
		.replace('TemplateRegistrationDescription', '')
		.replace('RegistrationDescription', ''),
)
const template = computed(() => kind.value.includes('Template'))
const handleField = computed(
	() =>
		({
			Apple: 'DeviceToken',
			FcmV1: 'FcmV1RegistrationId',
			Fcm: 'FcmRegistrationId',
			Gcm: 'GcmRegistrationId',
			Windows: 'ChannelUri',
			Mpns: 'ChannelUri',
			Adm: 'AdmRegistrationId',
			Baidu: 'BaiduUserId',
			Browser: 'Endpoint',
		})[prefix.value],
)
const title = computed(() =>
	mode.value === 'create'
		? 'Create registration'
		: mode.value === 'update'
			? 'Edit registration'
			: 'Delete registration',
)
const terminal = computed(
	() => !!store.outcome && ['confirmed', 'unknown'].includes(store.outcome.status),
)
const conflict = computed(() => store.outcome?.summary.includes('ETag conflict'))
const disabled = computed(() => !!store.busy || terminal.value)
function parse(raw: string) {
	if (/<!DOCTYPE|<!ENTITY/i.test(raw))
		throw new Error('DTD and entity declarations are not allowed.')
	const doc = new DOMParser().parseFromString(raw, 'application/xml')
	if (
		doc.getElementsByTagName('parsererror').length ||
		doc.documentElement.namespaceURI !== service
	)
		throw new Error('Enter valid registration description XML.')
	return doc
}
function field(doc: Document, name: string) {
	return [...doc.documentElement.children].find(
		(e) => e.localName === name && e.namespaceURI === service,
	)
}
function set(doc: Document, name: string, value: string) {
	let e = field(doc, name)
	if (!value) {
		e?.remove()
		return
	}
	if (!e) {
		e = doc.createElementNS(service, name)
		doc.documentElement.appendChild(e)
	}
	e.textContent = value
}
function buildCommon() {
	const doc = parse(xml.value)
	if (handleField.value) set(doc, handleField.value, handle.value)
	if (prefix.value === 'Baidu') set(doc, 'BaiduChannelId', extraHandle.value)
	if (prefix.value === 'Browser') {
		set(doc, 'P256DH', browserKey.value)
		set(doc, 'Auth', browserAuth.value)
	}
	if (template.value) {
		set(doc, 'BodyTemplate', body.value)
		if (prefix.value === 'Apple') set(doc, 'Expiry', expiry.value)
		const name = prefix.value === 'Windows' ? 'Wns' : prefix.value === 'Mpns' ? 'Mpns' : null
		if (name && headers.value !== originalHeaders.value) {
			field(doc, name + 'Headers')?.remove()
			if (headers.value.trim()) {
				const container = doc.createElementNS(service, name + 'Headers')
				for (const line of headers.value.split('\n').filter((v) => v.trim())) {
					const at = line.indexOf(':')
					if (at < 1) throw new Error('Enter each template header as Name: value.')
					const item = doc.createElementNS(service, name + 'Header')
					for (const [key, value] of [
						['Header', line.slice(0, at).trim()],
						['Value', line.slice(at + 1).trim()],
					]) {
						const e = doc.createElementNS(service, key)
						e.textContent = value
						item.appendChild(e)
					}
					container.appendChild(item)
				}
				doc.documentElement.appendChild(container)
			}
		}
		set(doc, 'TemplateName', templateName.value)
	}
	return new XMLSerializer().serializeToString(doc)
}
function load() {
	if (!current.value) return
	const details = current.value.details
	kind.value = details?.registration.kind ?? 'FcmV1RegistrationDescription'
	xml.value = details?.rawXml ?? `<${kind.value} xmlns="${service}" />`
	const doc = parse(xml.value),
		read = (n: string) => field(doc, n)?.textContent ?? ''
	handle.value = handleField.value ? read(handleField.value) : ''
	tags.value = details?.registration.tags.join(', ') ?? ''
	body.value = read('BodyTemplate')
	templateName.value = read('TemplateName')
	extraHandle.value = read('BaiduChannelId')
	expiry.value = read('Expiry')
	browserKey.value = read('P256DH')
	browserAuth.value = read('Auth')
	const name = prefix.value === 'Windows' ? 'Wns' : 'Mpns'
	headers.value = [...(field(doc, name + 'Headers')?.children ?? [])]
		.map(
			(h) =>
				`${[...h.children].find((e) => e.localName === 'Header')?.textContent ?? ''}: ${[...h.children].find((e) => e.localName === 'Value')?.textContent ?? ''}`,
		)
		.join('\n')
	originalHeaders.value = headers.value
	advanced.value = !handleField.value
	acknowledge.value = false
	formError.value = ''
}
watch(() => current.value?.details?.registration.snapshotId, load, { immediate: true })
watch(
	[
		kind,
		handle,
		tags,
		body,
		templateName,
		extraHandle,
		expiry,
		headers,
		xml,
		advanced,
		browserKey,
		browserAuth,
	],
	() => {
		acknowledge.value = false
	},
)
function selectKind() {
	xml.value = `<${kind.value} xmlns="${service}" />`
	body.value = template.value
		? prefix.value === 'Windows' || prefix.value === 'Mpns'
			? '<toast><visual><binding template="ToastText01"><text id="1">$(message)</text></binding></visual></toast>'
			: '{"notification":{"title":"$(title)","body":"$(message)"}}'
		: ''
	if (prefix.value === 'FcmV1' && template.value)
		body.value = '{"message":{"notification":{"title":"$(title)","body":"$(message)"}}}'
	if (prefix.value === 'Apple' && template.value) body.value = '{"aps":{"alert":"$(message)"}}'
	headers.value =
		prefix.value === 'Windows'
			? 'X-WNS-Type: wns/toast'
			: prefix.value === 'Mpns'
				? 'X-WindowsPhone-Target: toast'
				: ''
	originalHeaders.value = ''
	handle.value = extraHandle.value = templateName.value = expiry.value = ''
	browserKey.value = browserAuth.value = ''
	advanced.value = false
	acknowledge.value = false
}
function switchAdvanced() {
	try {
		if (!advanced.value) {
			xml.value = buildCommon()
			advanced.value = true
		} else {
			formError.value =
				'Close and reopen the editor to return to common fields without discarding advanced XML changes.'
		}
	} catch (e) {
		formError.value = (e as Error).message
	}
}
async function submit() {
	if (!acknowledge.value || disabled.value || store.blocked || conflict.value) return
	try {
		const draft =
			mode.value === 'delete'
				? null
				: {
						rawXml: advanced.value ? xml.value : buildCommon(),
						tags: tags.value
							.split(/[,\n]/)
							.map((v) => v.trim())
							.filter(Boolean),
					}
		if (draft) {
			parse(draft.rawXml)
			if (!nhRegistrationDraftSchema.safeParse(draft).success)
				throw new Error(
					'Use up to 60 unique tags of 1–120 allowed characters, and registration XML under 128 KiB.',
				)
		}
		formError.value = ''
		await store.change({
			action: mode.value,
			snapshotId:
				mode.value === 'create'
					? null
					: (current.value.details?.registration.snapshotId ?? null),
			draft,
			acknowledge: true,
		})
		acknowledge.value = false
	} catch (e) {
		formError.value = e instanceof Error ? e.message : 'Check the registration definition.'
	}
}
</script>
<template>
	<Dialog :open="true" @update:open="!$event && store.closeEditor()">
		<DialogContent
			class="sm:max-w-[900px] nh-dialog nh-registration-inspector nh-registration-editor"
			@escape-key-down="store.busy && $event.preventDefault()"
			@pointer-down-outside="$event.preventDefault()"
		>
			<DialogHeader
				><DialogTitle>{{ title }}</DialogTitle
				><DialogDescription
					>{{ store.connection?.hubName }} ·
					{{
						mode === 'create'
							? 'Azure assigns the registration ID'
							: current.details?.registration.registrationId
					}}</DialogDescription
				></DialogHeader
			>
			<p v-if="current.details && mode !== 'create'" class="field-hint">
				Fresh read ETag: {{ current.details.etag ?? 'Missing — reload required' }}. Azure
				rejects stale updates and deletes.
			</p>

			<p v-if="legacyRegistrationWarning(kind)" class="form-warning">
				{{ legacyRegistrationWarning(kind) }}
			</p>
			<form class="nh-form" @submit.prevent="submit">
				<div class="nh-registration-editor-fields">
					<template v-if="mode !== 'delete'">
						<label
							>Registration platform<select
								aria-label="Registration platform"
								v-model="kind"
								:disabled="mode === 'update' || disabled"
								@change="selectKind"
							>
								<option v-for="value in kinds" :key="value" :value="value">
									{{
										value
											.replace('RegistrationDescription', '')
											.replace('Template', ' · Template')
									}}
								</option>
								<option v-if="!kinds.includes(kind)" :value="kind">
									{{ kind }}
								</option>
							</select></label
						>
						<label
							>Registration tags<textarea
								aria-label="Registration tags"
								v-model="tags"
								:disabled="disabled"
								rows="2"
								placeholder="news, customer:123"
							/>
						</label>
						<p class="field-hint">
							Up to 60 unique tags, separated by commas or new lines. Allowed:
							letters, digits, _ @ # . : ~ -
						</p>
						<template v-if="!advanced">
							<label
								>Registration device handle ({{ handleField }})<Input
									aria-label="Registration device handle"
									v-model="handle"
									:disabled="disabled"
							/></label>
							<label v-if="prefix === 'Baidu'"
								>Baidu channel ID<Input v-model="extraHandle" :disabled="disabled"
							/></label>
							<template v-if="prefix === 'Browser'"
								><label
									>Browser P256DH key<Input
										v-model="browserKey"
										aria-label="Browser P256DH key"
										:disabled="disabled" /></label
								><label
									>Browser Auth secret<Input
										v-model="browserAuth"
										aria-label="Browser Auth secret"
										type="password"
										:disabled="disabled" /></label
							></template>
							<template v-if="template"
								><label
									>Registration template body<textarea
										aria-label="Registration template body"
										v-model="body"
										:disabled="disabled"
										rows="7"
										class="nh-code-input"
									/></label
								><label
									>Registration template name (optional)<Input
										aria-label="Registration template name"
										v-model="templateName"
										:disabled="disabled" /></label
								><label v-if="prefix === 'Apple'"
									>APNS expiry expression (optional)<Input
										v-model="expiry"
										:disabled="disabled" /></label
								><label v-if="prefix === 'Windows' || prefix === 'Mpns'"
									>Template headers (Name: value, one per line)<textarea
										aria-label="Registration template headers"
										v-model="headers"
										:disabled="disabled"
										rows="3"
									/></label
							></template>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								:disabled="disabled"
								@click="switchAdvanced"
								>Advanced registration XML…</Button
							>
						</template>
						<template v-else
							><label
								>Registration description XML<textarea
									aria-label="Registration description XML"
									v-model="xml"
									:disabled="disabled"
									rows="12"
									class="nh-code-input"
								/>
							</label>
							<p class="field-hint">
								Edit platform fields and headers here. The tags above replace XML
								Tags. ID and platform type stay fixed when editing; ETag and
								expiration are read-only.
							</p></template
						>
					</template>
					<p v-else class="form-warning">
						Delete this device registration and its tags/template from this hub. This
						cannot be undone.
					</p>
					<p v-if="mode === 'update'" class="field-hint">
						Fields outside the common form are preserved. Use advanced XML to review or
						change them.
					</p>
					<label class="nh-check"
						><input
							type="checkbox"
							v-model="acknowledge"
							:disabled="disabled || conflict"
						/>I reviewed this registration {{ mode }} and its target hub.</label
					>
					<p v-if="formError || store.error" class="form-error" role="alert">
						{{ formError || store.error }}
					</p>
					<section v-if="store.outcome" class="nh-registration-receipt" role="status">
						<strong>{{ store.outcome.status }}</strong> · {{ store.outcome.summary }}
						<p>Registration ID: {{ store.outcome.registrationId ?? 'Unknown' }}</p>
						<p class="field-hint">Receipt {{ store.outcome.operationId }}</p>
					</section>
					<div v-if="store.busy" role="status">
						{{ store.busy }}…<Button
							type="button"
							variant="outline"
							@click="store.cancel()"
							>Cancel registration operation</Button
						>
					</div>
				</div>
				<div class="nh-actions">
					<Button
						v-if="current.details && !terminal && mode !== 'create'"
						type="button"
						variant="outline"
						:disabled="store.blocked"
						@click="store.reloadEditor()"
						>Reload current registration</Button
					><Button
						v-if="!terminal"
						type="submit"
						:variant="mode === 'delete' ? 'destructive' : 'default'"
						:disabled="
							!acknowledge ||
							disabled ||
							store.blocked ||
							conflict ||
							(mode !== 'create' && !current.details?.etag)
						"
						>{{
							mode === 'create'
								? 'Create registration now'
								: mode === 'update'
									? 'Save registration'
									: 'Delete registration now'
						}}</Button
					><Button
						type="button"
						variant="outline"
						:disabled="!!store.busy"
						@click="store.closeEditor()"
						>Close registration editor</Button
					>
				</div>
			</form>
		</DialogContent>
	</Dialog>
</template>
<style>
.nh-dialog.nh-registration-editor {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	max-height: 85vh;
}
.nh-registration-editor form {
	display: flex;
	flex-direction: column;
	min-height: 0;
	overflow: hidden;
}
.nh-registration-editor-fields {
	display: grid;
	gap: 12px;
	min-height: 0;
	overflow-y: auto;
	padding-right: 6px;
}
.nh-registration-editor .nh-actions {
	flex-shrink: 0;
	padding-top: 8px;
}

.nh-code-input {
	font-family: var(--font-mono);
	font-size: 12px;
	min-height: 140px;
}
.nh-registration-receipt {
	padding: 12px;
	border: 1px solid var(--border);
	border-radius: 8px;
	overflow-wrap: anywhere;
}
.nh-check {
	display: flex !important;
	flex-direction: row !important;
	align-items: center;
	gap: 8px;
}
</style>
