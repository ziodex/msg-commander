<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import DesktopPreferences from './DesktopPreferences.vue'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from '@/shared/ui/dialog'
import { useWorkspace } from '@/shared/workspace/store'
import { defaultPreferences, preferencesSchema } from '@shared/application-settings'
import { platformApi } from '@/shared/platform/api'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const workspace = useWorkspace(),
	form = reactive({ ...workspace.preferences })
const busy = ref(false),
	checkingUpdates = ref(false),
	error = ref(''),
	notice = ref(''),
	revision = ref(0)
watch(
	() => props.open,
	(open) => {
		error.value = ''
		notice.value = ''
		if (open) {
			Object.assign(form, workspace.preferences)
			revision.value = workspace.preferenceState.revision
		}
	},
)
async function save() {
	const parsed = preferencesSchema.safeParse(form)
	if (!parsed.success) {
		error.value =
			'Use a peek size of 1–25, receive wait of 1–20 seconds and refresh of 0 (paused) or 10–3600 seconds. Headers allow 128 characters without line breaks.'
		return
	}
	busy.value = true
	error.value = ''
	try {
		await workspace.savePreferences(parsed.data, revision.value)
		revision.value = workspace.preferenceState.revision
		notice.value = 'Preferences saved.'
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Preferences could not be saved.'
	} finally {
		busy.value = false
	}
}
function resetDefaults() {
	Object.assign(form, defaultPreferences)
	notice.value = 'Defaults loaded. Save to apply.'
}
async function checkForUpdates() {
	checkingUpdates.value = true
	try {
		const result = await platformApi.checkForUpdates()
		if (!result.ok) error.value = result.error.message
	} catch {
		error.value = 'Could not check for updates. Try again.'
	} finally {
		checkingUpdates.value = false
	}
}
</script>

<template>
	<Dialog :open="open" @update:open="emit('update:open', $event)">
		<DialogContent class="preferences-dialog max-h-[88dvh] overflow-y-auto sm:max-w-[860px]">
			<DialogHeader
				><DialogTitle>Preferences</DialogTitle
				><DialogDescription>Local application defaults.</DialogDescription></DialogHeader
			>
			<div class="preferences-fields">
				<label
					>Messages per peek<Input
						v-model.number="form.peekCount"
						type="number"
						min="1"
						max="25"
						aria-label="Default messages per peek"
				/></label>
				<label
					>Receive wait (seconds)<Input
						v-model.number="form.receiveWaitSeconds"
						type="number"
						min="1"
						max="20"
						aria-label="Default receive wait"
				/></label>
				<label
					>Count refresh (seconds; 0 pauses)<Input
						v-model.number="form.countRefreshSeconds"
						type="number"
						min="0"
						max="3600"
						aria-label="Default count refresh"
				/></label>
				<label class="preferences-check"
					><input v-model="form.showMessageCounts" type="checkbox" />Show message counts
					in the tree and refresh automatically</label
				>
				<label
					>Default message subject<Input
						v-model="form.messageSubject"
						maxlength="128"
						aria-label="Default message subject"
				/></label>
				<label
					>Default content type<Input
						v-model="form.messageContentType"
						maxlength="128"
						aria-label="Default message content type"
				/></label>
			</div>
			<div class="desktop-preferences-actions">
				<Button :disabled="busy" @click="save">Save preferences</Button
				><Button variant="outline" :disabled="busy" @click="resetDefaults"
					>Reset defaults</Button
				>
			</div>
			<DesktopPreferences />
			<section aria-label="Application updates">
				<h3>Application updates</h3>
				<p>
					Version {{ workspace.version }}. Release builds check automatically and ask
					before restarting.
				</p>
				<Button variant="outline" :disabled="checkingUpdates" @click="checkForUpdates">{{
					checkingUpdates ? 'Checking for updates…' : 'Check for updates'
				}}</Button>
			</section>

			<p v-if="notice" role="status">{{ notice }}</p>
			<p v-if="error" role="alert" class="form-error">{{ error }}</p>
			<div class="dialog-actions">
				<Button variant="outline" @click="emit('update:open', false)"
					>Close preferences</Button
				>
			</div>
		</DialogContent>
	</Dialog>
</template>

<style scoped>
.preferences-fields {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 14px;
}
.preferences-fields label {
	display: grid;
	gap: 6px;
	font-size: 13px;
}
.preferences-fields .preferences-check {
	display: flex;
	align-items: center;
	gap: 8px;
}
</style>
