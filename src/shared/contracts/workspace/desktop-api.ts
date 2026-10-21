import {
	type DesktopResult,
	type Bootstrap,
	type Operation,
	type OperationResult,
} from '../platform/desktop'
import { type ProfileInput, type Profile, type Theme } from '../platform/profiles'
import { type OperationLogRequest } from '../../desktop-tools'
import { type Preferences, type PreferenceState } from '../../application-settings'
import { type AppEvent } from '../platform/events'

export interface WorkspaceDesktopApi {
	checkForUpdates(): Promise<DesktopResult<void>>
	bootstrap(): Promise<DesktopResult<Bootstrap>>
	saveProfile(profile: ProfileInput): Promise<DesktopResult<Profile[]>>
	removeProfile(id: string): Promise<DesktopResult<Profile[]>>
	runOperation(operation: Operation): Promise<DesktopResult<OperationResult>>
	cancelOperation(id: string): Promise<DesktopResult<void>>
	restartBackend(): Promise<DesktopResult<void>>
	setTheme(theme: Theme): Promise<DesktopResult<void>>
	setInterfaceScale(scale: number): Promise<DesktopResult<null>>
	exportOperationLog(
		input: OperationLogRequest,
	): Promise<DesktopResult<{ cancelled: boolean; fileName?: string }>>
	savePreferences(input: {
		preferences: Preferences
		revision: number
	}): Promise<DesktopResult<PreferenceState>>
	openDeviceLogin(): Promise<DesktopResult<void>>
	onEvent(callback: (event: AppEvent) => void): () => void
}
