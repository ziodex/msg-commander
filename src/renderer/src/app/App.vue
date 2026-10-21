<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronRight, Globe, ListTree, PanelBottom, PanelLeft, Plus, X } from '@lucide/vue'
import { Button } from '@/shared/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/shared/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/shared/ui/resizable'
import { ConnectionDialog } from '@/features/connections'
import { ApplicationPreferences } from '@/features/preferences'
import { BodyCodecDialog } from '@/features/body-tools'
import { ServiceBusWorkspace } from '@/features/service-bus'
import { EventHubsExplorer } from '@/features/event-hubs'
import { NotificationHubsExplorer } from '@/features/notification-hubs'
import { EventGridExplorer } from '@/features/event-grid'
import { RelayExplorer } from '@/features/relay'
import { useDesktopPreferences } from '@/shared/preferences/store'
import { services, useWorkspace } from '@/shared/workspace/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
import { platformApi } from '@/shared/platform/api'
import type { Profile } from '@shared/contracts'
import OperationsLog from './components/OperationsLog.vue'
import AppNavigation from './components/AppNavigation.vue'
import WorkspaceOverview from './components/WorkspaceOverview.vue'
import CommandPalette from './components/CommandPalette.vue'
import { useMessagingServices } from './composables/useMessagingServices'
import { useLayoutPanels } from './composables/useLayoutPanels'
import { serviceIcons as icons } from './service-icons'

const store = useWorkspace(),
	desktop = useDesktopPreferences(),
	layout = useWorkspaceLayout()
const messaging = useMessagingServices()
const { sb, eh, nh, relay, grid, registrations, notifications, connectedProfileIds } = messaging
const { sidebarHidden, operationsHidden, operationsMode, toggleSidebar, toggleOperations } =
	useLayoutPanels()
const connectionOpen = ref(false),
	editing = ref<Profile>(),
	removing = ref<Profile>()
const paletteOpen = ref(false),
	preferencesOpen = ref(false),
	bodyCodecsOpen = ref(false)
function openConnection(profile?: Profile) {
	editing.value = profile
	connectionOpen.value = true
}
async function removeSelectedProfile() {
	if (removing.value) await store.remove(removing.value.id)
	removing.value = undefined
}
const commands = computed(() => [
	{ name: 'Add a connection', detail: 'Workspace', action: () => openConnection() },
	{
		name: 'Body tools',
		detail: 'Text encoding and compression',
		action: () => {
			bodyCodecsOpen.value = true
		},
	},
	{
		name: 'Preferences',
		detail: 'Appearance, layout and messaging defaults',
		action: () => {
			preferencesOpen.value = true
		},
	},
	...(store.selected?.service === 'service-bus' && sb.connection?.profileId !== store.selected.id
		? [
				{
					name: 'Connect selected connection',
					detail: store.selected.name,
					action: () => {
						if (store.selected) void sb.connect(store.selected.id)
					},
				},
			]
		: []),
	{
		name: sidebarHidden.value ? 'Show navigation sidebar' : 'Hide navigation sidebar',
		detail: 'Layout',
		action: toggleSidebar,
	},
	{
		name: operationsHidden.value ? 'Show Operations log' : 'Hide Operations log',
		detail: 'Layout',
		action: toggleOperations,
	},
	{
		name: layout.treeVisible ? 'Hide entity tree' : 'Show entity tree',
		detail: 'Layout',
		action: () => {
			layout.treeVisible = !layout.treeVisible
		},
	},
	{
		name: 'Run local diagnostics',
		detail: 'No Azure calls',
		action: () => {
			void store.run('diagnostics')
		},
	},
	{
		name: 'Restart backend',
		detail: 'Cancels active operations',
		action: () => {
			void store.restart()
		},
	},
	...services.map((service) => ({
		name: service.name,
		detail: 'Service workspace',
		action: () => store.selectService(service.id),
	})),
	...store.profiles.map((profile) => ({
		name: profile.name,
		detail: profile.namespace,
		action: () => store.selectProfile(profile),
	})),
])
let unsubscribe: (() => void) | undefined
onMounted(async () => {
	unsubscribe = platformApi.onEvent((event) => {
		if (event.type === 'command') {
			if (event.command === 'new-connection') openConnection()
			else paletteOpen.value = !paletteOpen.value
		} else messaging.receive(event)
	})
	await store.initialize()
	try {
		await desktop.initialize()
	} catch (cause) {
		store.error = cause instanceof Error ? cause.message : 'Appearance could not be loaded.'
	}
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
	<div class="desktop-shell" :class="{ mac: store.platform === 'darwin' }">
		<header v-if="store.platform === 'darwin'" class="titlebar">
			<span>Msg Commander</span><span class="titlebar-label">LOCAL WORKSPACE</span>
		</header>
		<ResizablePanelGroup
			direction="horizontal"
			class="workspace-layout"
			auto-save-id="commander-layout-v2"
		>
			<ResizablePanel
				ref="sidebar"
				id="navigation-panel"
				:default-size="20"
				:min-size="20"
				:max-size="32"
				:collapsible="true"
				:collapsed-size="0"
				class="sidebar-panel"
				@collapse="sidebarHidden = true"
				@expand="sidebarHidden = false"
			>
				<AppNavigation
					:hidden="sidebarHidden"
					:connected-profile-ids="connectedProfileIds"
					@connection="openConnection()"
					@palette="paletteOpen = true"
					@body-tools="bodyCodecsOpen = true"
					@preferences="preferencesOpen = true"
				/>
			</ResizablePanel>
			<ResizableHandle v-show="!sidebarHidden" />
			<ResizablePanel id="main-panel" :default-size="80" :min-size="60">
				<main
					class="main-workspace"
					:class="{
						'connected-workspace':
							!!store.selectedId &&
							((store.service === 'service-bus' &&
								sb.connection?.profileId === store.selectedId) ||
								(['event-hubs', 'iot-hub'].includes(store.service) &&
									eh.connection?.profileId === store.selectedId) ||
								(store.service === 'relay' &&
									relay.connection?.profileId === store.selectedId) ||
								(store.service === 'event-grid' &&
									grid.connection?.profileId === store.selectedId) ||
								(store.service === 'notification-hubs' &&
									(nh.connection?.profileId === store.selectedId ||
										registrations.connection?.profileId === store.selectedId ||
										notifications.connection?.profileId === store.selectedId))),
					}"
				>
					<div class="workspace-toolbar">
						<div class="breadcrumb">
							<span>Workspace</span><ChevronRight :size="13" /><component
								:is="icons[store.service]"
								:size="15"
							/><strong>{{ store.activeService.name }}</strong
							><template v-if="store.selected"
								><ChevronRight :size="13" /><span class="truncate">{{
									store.selected.name
								}}</span></template
							>
						</div>
						<div class="layout-controls" role="group" aria-label="Workspace layout">
							<Button
								variant="ghost"
								size="icon-sm"
								:aria-label="
									sidebarHidden
										? 'Show navigation sidebar'
										: 'Hide navigation sidebar'
								"
								:title="
									sidebarHidden
										? 'Show navigation sidebar'
										: 'Hide navigation sidebar'
								"
								:aria-pressed="!sidebarHidden"
								aria-controls="navigation-panel"
								@click="toggleSidebar"
								><PanelLeft :size="16"
							/></Button>
							<Button
								v-if="
									(sb.connection && store.service === 'service-bus') ||
									(eh.connection &&
										['event-hubs', 'iot-hub'].includes(store.service)) ||
									(relay.connection && store.service === 'relay') ||
									(nh.connection && store.service === 'notification-hubs')
								"
								variant="ghost"
								size="icon-sm"
								:aria-label="
									layout.treeVisible ? 'Hide entity tree' : 'Show entity tree'
								"
								:title="
									layout.treeVisible ? 'Hide entity tree' : 'Show entity tree'
								"
								:aria-pressed="layout.treeVisible"
								@click="layout.treeVisible = !layout.treeVisible"
								><ListTree :size="16"
							/></Button>
							<Button
								variant="ghost"
								size="sm"
								:aria-label="
									operationsHidden ? 'Show Operations log' : 'Hide Operations log'
								"
								:title="
									operationsHidden ? 'Show Operations log' : 'Hide Operations log'
								"
								:aria-pressed="!operationsHidden"
								aria-controls="operations-panel"
								@click="toggleOperations"
								><PanelBottom :size="16" /><span
									v-if="store.running"
									class="layout-running"
									>{{ store.running }}</span
								></Button
							>
						</div>
					</div>
					<div v-if="store.error" class="error-banner" role="alert">
						{{ store.error
						}}<button aria-label="Dismiss error" @click="store.error = ''">
							<X :size="16" />
						</button>
					</div>
					<div v-if="store.status.state === 'crashed'" class="error-banner" role="alert">
						{{ store.status.detail
						}}<Button variant="outline" size="sm" @click="store.restart()"
							>Restart backend</Button
						>
					</div>
					<ResizablePanelGroup
						direction="vertical"
						class="content-split"
						auto-save-id="commander-jobs-v4"
					>
						<ResizablePanel id="content-panel" :default-size="100" :min-size="45">
							<div class="workspace-scroll">
								<div class="page-heading">
									<div>
										<h1>
											{{ store.selected?.name ?? store.activeService.name }}
										</h1>
										<p>
											{{
												store.selected?.namespace ??
												store.activeService.description
											}}
										</p>
									</div>
									<Button variant="outline" size="sm" @click="openConnection()"
										><Plus />New connection</Button
									>
								</div>
								<ServiceBusWorkspace
									v-if="
										store.service === 'service-bus' &&
										store.selected &&
										sb.connection?.profileId === store.selected.id
									"
								/>
								<EventHubsExplorer
									v-else-if="
										['event-hubs', 'iot-hub'].includes(store.service) &&
										store.selected
									"
									:profile="store.selected"
									@settings="openConnection(store.selected)"
									@remove="removing = store.selected"
								/>
								<NotificationHubsExplorer
									v-else-if="
										store.service === 'notification-hubs' && store.selected
									"
									:key="store.selected.id"
									:profile="store.selected"
									@settings="openConnection(store.selected)"
									@remove="removing = store.selected"
								/>
								<EventGridExplorer
									v-else-if="store.service === 'event-grid' && store.selected"
									:key="store.selected.id"
									:profile="store.selected"
									@settings="openConnection(store.selected)"
									@remove="removing = store.selected"
								/>
								<RelayExplorer
									v-else-if="store.service === 'relay' && store.selected"
									:profile="store.selected"
									@settings="openConnection(store.selected)"
									@remove="removing = store.selected"
								/>
								<template v-else>
									<WorkspaceOverview
										@connection="openConnection"
										@remove="removing = $event"
									/>
								</template>
							</div>
						</ResizablePanel>
						<ResizableHandle v-show="!operationsHidden" />
						<ResizablePanel
							ref="operations"
							id="operations-panel"
							:default-size="0"
							:min-size="8"
							:max-size="45"
							:collapsible="true"
							:collapsed-size="0"
							@collapse="operationsHidden = true"
							@expand="operationsHidden = false"
						>
							<OperationsLog
								v-show="!operationsHidden"
								@pointerdown="operationsMode = 'open'"
								@focusin="operationsMode = 'open'"
							/>
						</ResizablePanel>
					</ResizablePanelGroup>
				</main>
			</ResizablePanel>
		</ResizablePanelGroup>
		<footer class="statusbar">
			<div>
				<span class="status-dot" :class="store.status.state"></span
				><span>{{
					store.ready ? 'Backend connected' : `Backend ${store.status.state}`
				}}</span
				><span class="status-divider">/</span
				><span
					>{{ store.profiles.length }} saved
					{{ store.profiles.length === 1 ? 'connection' : 'connections' }}</span
				>
			</div>
			<div>
				<Globe :size="12" /><span>{{
					store.selected?.emulatorManagementPort ? 'Local emulator' : 'Azure Public Cloud'
				}}</span
				><span class="status-divider">/</span><span>v{{ store.version }}</span>
			</div>
		</footer>
		<ConnectionDialog v-model:open="connectionOpen" :profile="editing" />
		<CommandPalette v-model:open="paletteOpen" :commands="commands" />
		<Dialog :open="!!removing" @update:open="!$event && (removing = undefined)"
			><DialogContent
				><DialogHeader
					><DialogTitle>Remove {{ removing?.name }}?</DialogTitle
					><DialogDescription
						>This removes the local profile and saved credential. Azure resources are
						unaffected.</DialogDescription
					></DialogHeader
				>
				<div class="dialog-actions">
					<Button variant="outline" @click="removing = undefined">Keep connection</Button
					><Button variant="destructive" @click="removeSelectedProfile()"
						>Remove connection</Button
					>
				</div></DialogContent
			></Dialog
		>
		<ApplicationPreferences v-model:open="preferencesOpen" />
		<BodyCodecDialog v-model:open="bodyCodecsOpen" />
	</div>
</template>
