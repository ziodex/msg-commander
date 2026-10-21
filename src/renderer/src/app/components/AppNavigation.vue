<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, Moon, Plus, Search, Settings, Sun, Wrench } from '@lucide/vue'
import appIcon from '@/assets/msg-commander-icon.png'
import { Button } from '@/shared/ui/button'
import { services, useWorkspace } from '@/shared/workspace/store'
import { useDesktopAppearance } from '../composables/useDesktopAppearance'
import { serviceIcons } from '../service-icons'
defineProps<{ hidden: boolean; connectedProfileIds: string[] }>()
const emit = defineEmits<{ connection: []; palette: []; bodyTools: []; preferences: [] }>()
const store = useWorkspace()
const { dark } = useDesktopAppearance()
const visibleProfiles = computed(() =>
	store.profiles.filter((profile) => profile.service === store.service),
)
</script>
<template>
	<aside v-show="!hidden" class="sidebar" aria-label="Workspace navigation">
		<div class="brand">
			<img class="brand-mark" :src="appIcon" alt="" width="44" height="44" />
			<div>
				Msg<strong>Commander<span class="brand-dot">.</span></strong>
			</div>
		</div>
		<button class="search-launch" aria-keyshortcuts="Control+K Meta+K" @click="emit('palette')">
			<Search :size="15" /><span>Search commands</span
			><kbd aria-hidden="true">{{ store.platform === 'darwin' ? '⌘' : 'Ctrl' }} K</kbd>
		</button>
		<div class="section-label">Services</div>
		<nav class="service-nav">
			<button
				v-for="item in services"
				:key="item.id"
				:class="{ active: store.service === item.id }"
				:aria-current="store.service === item.id ? 'page' : undefined"
				@click="store.selectService(item.id)"
			>
				<component :is="serviceIcons[item.id]" :size="17" /><span>{{ item.name }}</span
				><ChevronRight v-if="store.service === item.id" :size="14" />
			</button>
		</nav>
		<div class="connections-heading">
			<span class="section-label"
				>Connections <span class="count">{{ visibleProfiles.length }}</span></span
			><Button
				variant="ghost"
				size="icon-xs"
				aria-label="Add a connection"
				@click="emit('connection')"
				><Plus
			/></Button>
		</div>
		<div class="connection-list">
			<button
				v-for="profile in visibleProfiles"
				:key="profile.id"
				class="connection-item"
				:class="{ selected: store.selectedId === profile.id }"
				@click="store.selectProfile(profile)"
			>
				<span
					class="connection-dot"
					:class="{
						'connected-dot': connectedProfileIds.includes(profile.id),
					}"
				></span>
				<div>
					<strong>{{ profile.name }}</strong
					><small>{{ profile.namespace }}</small>
				</div>
			</button>
			<div v-if="!visibleProfiles.length" class="sidebar-empty">
				<p>No connections</p>
			</div>
		</div>
		<div class="sidebar-bottom">
			<button @click="emit('bodyTools')"><Wrench :size="16" />Body tools</button>

			<button @click="emit('preferences')"><Settings :size="16" />Preferences</button>
			<div class="theme-control">
				<span>Appearance</span
				><button
					:aria-label="dark ? 'Switch to light theme' : 'Switch to dark theme'"
					@click="store.setTheme(dark ? 'light' : 'dark')"
				>
					<Sun v-if="dark" :size="16" /><Moon v-else :size="16" /></button
				><button
					class="system-theme"
					:class="{ selected: store.theme === 'system' }"
					@click="store.setTheme('system')"
				>
					System
				</button>
			</div>
		</div>
	</aside>
</template>
