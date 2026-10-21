import { nextTick, ref, useTemplateRef, watch } from 'vue'
import { ResizablePanel } from '@/shared/ui/resizable'
import { useWorkspace } from '@/shared/workspace/store'
import { useWorkspaceLayout } from '@/shared/workspace/layout'
export function useLayoutPanels() {
	const store = useWorkspace(),
		layout = useWorkspaceLayout()
	// String template refs must remain registered even without a script binding in App.vue.
	const sidebar = useTemplateRef<InstanceType<typeof ResizablePanel>>('sidebar'),
		operations = useTemplateRef<InstanceType<typeof ResizablePanel>>('operations')
	const sidebarHidden = ref(false),
		operationsHidden = ref(true)
	const operationsMode = ref<'auto' | 'open' | 'closed'>('auto')
	function toggleSidebar() {
		if (sidebarHidden.value) sidebar.value?.expand()
		else sidebar.value?.collapse()
	}
	function toggleOperations() {
		operationsMode.value = operationsHidden.value ? 'open' : 'closed'
		if (operationsHidden.value) operations.value?.resize(18)
		else operations.value?.collapse()
	}
	watch(
		() => store.running,
		async () => {
			if (operationsMode.value !== 'auto') return
			await nextTick()
			// Explicit user sizing takes precedence while a render is pending.
			if (operationsMode.value !== 'auto') return
			if (store.running || store.jobs[0]?.status === 'failed') operations.value?.resize(18)
			else operations.value?.collapse()
		},
	)
	watch(
		() => layout.resetVersion,
		() => {
			sidebar.value?.resize(20)
			operationsMode.value = 'auto'
			if (store.running) operations.value?.resize(18)
			else operations.value?.collapse()
		},
	)
	return {
		sidebarHidden,
		operationsHidden,
		operationsMode,
		toggleSidebar,
		toggleOperations,
	}
}
