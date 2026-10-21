export interface WorkspaceCommand {
	name: string
	detail: string
	action: () => void
}
