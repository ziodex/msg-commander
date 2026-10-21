<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { KeyRound, Fingerprint } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@/shared/ui/dialog'
import { useWorkspace, services } from '@/shared/workspace/store'
import { parseIotEndpoint } from '@shared/iot-hub'
import { profileInputSchema, type Profile, type ProfileInput } from '@shared/contracts'

const props = defineProps<{ open: boolean; profile?: Profile }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const store = useWorkspace()
const empty = (): ProfileInput => ({
	id: crypto.randomUUID(),
	name: '',
	namespace: '',
	service: store.service,
	auth: ['relay', 'notification-hubs', 'event-grid'].includes(store.service)
		? 'device-code'
		: 'sas',
	tenantId: '',
	clientId: '',
	secret: '',
	rememberSecret: false,
})
const form = reactive(empty())
const isEventGrid = computed(() => form.service === 'event-grid')
const isIot = computed(() => form.service === 'iot-hub')
const isEmulator = computed(() => form.emulatorManagementPort !== undefined)
function toggleEmulator(enabled: boolean) {
	if (enabled) {
		form.emulatorManagementPort = 5300
		form.auth = 'sas'
		form.namespace = 'localhost'
		if (!form.name) form.name = 'Service Bus emulator'
		form.secret =
			'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;'
	} else {
		delete form.emulatorManagementPort
		form.namespace = ''
		form.secret = ''
	}
}
watch(
	() => form.service,
	() => {
		if (form.service !== 'service-bus') delete form.emulatorManagementPort
		if (isEventGrid.value) {
			form.secret = ''
			form.rememberSecret = false
		}
		if (isIot.value) form.auth = 'sas'
		if (['relay', 'notification-hubs', 'event-grid'].includes(form.service))
			form.auth = 'device-code'
	},
)
watch(
	() => form.secret,
	(value) => {
		if (isIot.value) error.value = ''
		if (isIot.value && value) {
			try {
				form.namespace = parseIotEndpoint(value).namespace
			} catch {
				// Submission shows the endpoint requirements.
			}
		}
	},
)
const error = ref('')
const saving = ref(false)
watch(
	() => props.open,
	(open) => {
		error.value = ''
		delete form.emulatorManagementPort
		Object.assign(
			form,
			empty(),
			open && props.profile ? { ...props.profile, secret: '', rememberSecret: false } : {},
		)
		// Public profile DTO has a display-only field; never send it back in the command.
		delete (form as ProfileInput & { secretState?: string }).secretState
	},
)
async function submit() {
	error.value = ''
	if (isIot.value) {
		try {
			form.namespace = parseIotEndpoint(form.secret ?? '').namespace
		} catch (cause) {
			error.value = cause instanceof Error ? cause.message : 'Invalid IoT Hub endpoint.'
			return
		}
	}
	const parsed = profileInputSchema.safeParse(form)
	if (!parsed.success) {
		error.value = parsed.error.issues[0].message
		return
	}
	if (form.auth === 'sas' && !form.secret?.trim()) {
		error.value =
			'Enter the namespace connection string. Saved secrets are never sent back to this form.'
		return
	}
	saving.value = true
	try {
		await store.save(parsed.data)
		form.secret = ''
		emit('update:open', false)
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Unable to save connection.'
	} finally {
		saving.value = false
	}
}
</script>

<template>
	<Dialog :open="open" @update:open="emit('update:open', $event)">
		<DialogContent class="connection-dialog sm:max-w-[570px]">
			<DialogHeader>
				<div class="dialog-emblem"><Fingerprint :size="22" /></div>
				<DialogTitle>{{
					profile ? 'Connection settings' : 'Add a connection'
				}}</DialogTitle>
				<DialogDescription>Saving does not connect.</DialogDescription>
			</DialogHeader>
			<form :novalidate="isIot" class="connection-form" @submit.prevent="submit">
				<div class="form-grid">
					<label for="connection-name"
						>Connection name<Input
							id="connection-name"
							v-model="form.name"
							placeholder="e.g. Development"
							:maxlength="80"
							required
					/></label>
					<label for="connection-service"
						>Azure service<select id="connection-service" v-model="form.service">
							<option v-for="item in services" :key="item.id" :value="item.id">
								{{ item.name }}
							</option>
						</select></label
					>
				</div>
				<label v-if="form.service === 'service-bus'" class="checkbox-label">
					<input
						type="checkbox"
						:checked="isEmulator"
						@change="toggleEmulator(($event.target as HTMLInputElement).checked)"
					/>
					Local emulator
				</label>
				<label for="connection-namespace"
					>Namespace hostname<Input
						id="connection-namespace"
						aria-label="Namespace hostname"
						aria-describedby="namespace-hint"
						v-model="form.namespace"
						:readonly="isIot"
						:placeholder="
							isEventGrid
								? 'your-namespace.westeurope-1.eventgrid.azure.net'
								: 'your-namespace.servicebus.windows.net'
						"
						required
						autocapitalize="none"
						spellcheck="false"
					/><span id="namespace-hint" class="field-hint">{{
						isIot
							? 'From the compatible endpoint connection string.'
							: 'Hostname only; no scheme or path.'
					}}</span></label
				>
				<p v-if="isIot" class="field-hint">
					Use IoT Hub → Built-in endpoints → Event Hubs-compatible connection string.
					Requires EntityPath and ServiceConnect permission; device connection strings are
					unsupported.
				</p>
				<label v-if="isEmulator"
					>Management port<Input
						v-model.number="form.emulatorManagementPort"
						type="number"
						min="1"
						max="65535"
				/></label>
				<p v-if="isEmulator" class="field-hint">
					Local Service Bus over TCP. Data resets when the emulator restarts.
				</p>
				<fieldset>
					<legend>Authentication</legend>
					<div class="auth-options">
						<label v-if="!isEventGrid" :class="{ chosen: form.auth === 'sas' }"
							><input
								v-model="form.auth"
								type="radio"
								value="sas"
								name="auth"
							/><KeyRound :size="16" /> Connection string</label
						>
						<label
							v-if="!isIot && !isEmulator"
							:class="{ chosen: form.auth === 'device-code' }"
							><input
								v-model="form.auth"
								type="radio"
								value="device-code"
								name="auth"
							/><Fingerprint :size="16" /> Microsoft Entra</label
						>
					</div>
				</fieldset>
				<template v-if="form.auth === 'sas'">
					<label for="connection-secret"
						>{{
							isIot
								? 'Event Hubs-compatible connection string'
								: 'Namespace connection string'
						}}<Input
							id="connection-secret"
							:aria-label="
								isIot
									? 'Event Hubs-compatible connection string'
									: 'Namespace connection string'
							"
							v-model="form.secret"
							type="password"
							placeholder="Endpoint=sb://…;SharedAccessKeyName=…"
							autocomplete="off"
							spellcheck="false"
							required
					/></label>
					<label class="checkbox-label"
						><input v-model="form.rememberSecret" type="checkbox" /> Remember with the
						OS credential store</label
					>
					<p class="field-hint">
						Unchecked: session only. Saving remembered credentials may prompt for OS
						access.
					</p>
				</template>
				<div v-else class="entra-fields">
					<div class="form-grid">
						<label for="connection-tenant"
							>Directory (tenant) ID<Input
								id="connection-tenant"
								v-model="form.tenantId"
								placeholder="Tenant ID or domain"
								required /></label
						><label for="connection-client"
							>Application (client) ID<Input
								id="connection-client"
								v-model="form.clientId"
								placeholder="Public client application UUID"
								required
						/></label>
					</div>
					<p class="field-hint">
						Enable public client flows in the app registration. Azure Public Cloud only.
					</p>
				</div>
				<p v-if="error" class="form-error" role="alert">{{ error }}</p>
				<DialogFooter
					><Button variant="outline" type="button" @click="emit('update:open', false)"
						>Cancel</Button
					><Button type="submit" :disabled="saving">{{
						saving ? 'Saving…' : 'Save connection'
					}}</Button></DialogFooter
				>
			</form>
		</DialogContent>
	</Dialog>
</template>
