<script setup lang="ts">
import { Activity, Cpu, Fingerprint, Plus, Settings2, Trash2 } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import { Badge } from '@/shared/ui/badge'
import { useWorkspace } from '@/shared/workspace/store'
import { useServiceBus } from '@/features/service-bus'
import type { Profile } from '@shared/contracts'
import { serviceIcons } from '../service-icons'
const store = useWorkspace(),
	sb = useServiceBus()
const emit = defineEmits<{ connection: [profile?: Profile]; remove: [profile: Profile] }>()
</script>
<template>
	<div v-if="sb.error" class="error-banner" role="alert">{{ sb.error }}</div>
	<div class="overview-grid">
		<section v-if="!store.selected" class="welcome-card">
			<h2>No connection selected</h2>
			<p>Select a saved connection or add one.</p>
			<div class="welcome-actions">
				<Button @click="emit('connection')"><Plus />Add connection</Button>
			</div>
		</section>
		<section v-else class="profile-card">
			<div class="profile-top">
				<div class="service-emblem">
					<component :is="serviceIcons[store.service]" :size="25" />
				</div>
				<Badge variant="outline">Saved</Badge>
			</div>
			<h2>Connection details</h2>
			<dl class="profile-details">
				<div>
					<dt>Service</dt>
					<dd>{{ store.activeService.name }}</dd>
				</div>
				<div>
					<dt>Authentication</dt>
					<dd>
						{{
							store.selected.auth === 'sas'
								? 'Shared access signature'
								: 'Microsoft Entra device code'
						}}
					</dd>
				</div>
				<div>
					<dt>Credential storage</dt>
					<dd>
						{{
							store.selected.auth === 'device-code'
								? 'Sign-in on demand'
								: {
										none: 'Re-entry required',
										session: 'This session only',
										protected: 'OS credential store',
										locked: 'Credential store locked',
									}[store.selected.secretState]
						}}
					</dd>
				</div>
			</dl>
			<div class="profile-actions">
				<Button
					v-if="store.service === 'service-bus'"
					:disabled="!store.ready || !!store.running || !!sb.busy"
					@click="sb.connect(store.selected.id)"
					>Connect and browse</Button
				>
				<Button
					variant="outline"
					:disabled="!store.ready || store.service !== 'service-bus' || !!store.running"
					@click="store.run('test-profile', store.selected.id)"
					><Fingerprint />Verify authentication</Button
				><Button
					variant="outline"
					size="icon"
					aria-label="Connection settings"
					@click="emit('connection', store.selected)"
					><Settings2 /></Button
				><Button
					variant="ghost"
					size="icon"
					aria-label="Remove connection"
					@click="emit('remove', store.selected)"
					><Trash2
				/></Button>
			</div>
			<details v-if="store.service === 'service-bus'" class="profile-access">
				<summary>Required permissions</summary>
				<p class="field-hint">
					Browse: SAS Manage or Entra management read. Peek/receive/settle: Listen or Data
					Receiver. Send: Send or Data Sender. Authentication verification checks sign-in
					only.
				</p>
			</details>
		</section>
		<aside class="runtime-card" aria-label="Runtime status">
			<div class="card-overline">
				<Cpu :size="16" />
				<h2>Backend</h2>
			</div>
			<div class="runtime-status">
				<span class="status-dot" :class="store.status.state"></span>
				<h3>
					{{
						store.ready
							? 'Connected'
							: store.status.state === 'starting'
								? 'Starting…'
								: 'Unavailable'
					}}
				</h3>
			</div>
			<p v-if="!store.ready">{{ store.status.detail }}</p>
			<dl>
				<div>
					<dt>Runtime</dt>
					<dd>{{ store.status.runtime ?? 'Waiting…' }}</dd>
				</div>
			</dl>
			<Button
				variant="outline"
				class="diagnostics-button"
				:disabled="!store.ready || !!store.running"
				@click="store.run('diagnostics')"
				><Activity />Run local diagnostics</Button
			><button
				class="text-button"
				:disabled="store.status.state === 'starting'"
				@click="store.restart()"
			>
				Restart backend
			</button>
		</aside>
	</div>
</template>
