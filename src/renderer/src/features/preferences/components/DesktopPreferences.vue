<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { Button } from '@/shared/ui/button'
import { defaultDesktopPreferences } from '@shared/desktop-tools'
import { useDesktopPreferences } from '@/shared/preferences/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
const desktop = useDesktopPreferences(),
	layout = useWorkspaceLayout()
const form = reactive({ ...desktop.preferences }),
	error = ref(''),
	notice = ref(''),
	busy = ref(false)
watch(
	() => desktop.preferences,
	(value) => Object.assign(form, value),
)
async function save() {
	busy.value = true
	error.value = ''
	notice.value = ''
	try {
		await desktop.save({ ...form })
		notice.value = 'Appearance saved.'
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Appearance could not be saved.'
	} finally {
		busy.value = false
	}
}
function reset() {
	Object.assign(form, defaultDesktopPreferences)
	notice.value = 'Defaults loaded. Save to apply.'
}
function resetLayout() {
	layout.reset()
	notice.value = 'Layout reset.'
}
</script>
<template>
	<section class="desktop-preferences" aria-label="Appearance and layout">
		<h3>Appearance and layout</h3>
		<div class="preferences-fields">
			<label
				>Interface font<select v-model="form.font" aria-label="Interface font">
					<option value="plex">IBM Plex Sans</option>
					<option value="system">System</option>
					<option value="mono">Monospace</option>
				</select></label
			>
			<label
				>Interface size<select v-model.number="form.scale" aria-label="Interface size">
					<option :value="0.85">85%</option>
					<option :value="1">100%</option>
					<option :value="1.15">115%</option>
					<option :value="1.25">125%</option>
					<option :value="1.5">150%</option>
				</select></label
			>
			<label
				>Accent color<select v-model="form.accent" aria-label="Accent color">
					<option value="warm">Warm orange</option>
					<option value="blue">Blue</option>
					<option value="teal">Teal</option>
				</select></label
			>
		</div>
		<div class="desktop-preferences-actions">
			<Button :disabled="busy" @click="save">Save appearance</Button
			><Button variant="outline" :disabled="busy" @click="reset">Reset appearance</Button
			><Button variant="outline" :disabled="busy" @click="resetLayout">Reset layout</Button>
		</div>
		<p v-if="notice" role="status">{{ notice }}</p>
		<p v-if="error" role="alert" class="error-banner">{{ error }}</p>
	</section>
</template>
