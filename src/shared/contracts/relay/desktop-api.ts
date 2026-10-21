import { type AuthorizationKey } from '../../authorization'
import { type FileResult } from '../../message-files'
import { type DesktopResult } from '../platform/desktop'
import {
	type RelayConfigApply,
	type RelayConfigExport,
	type RelayConfigImportResult,
	type RelayConfigResult,
} from './configuration'
import {
	type RelayChange,
	type RelayConnect,
	type RelayConnection,
	type RelayCopyEndpoint,
	type RelayCopyKey,
	type RelayDetails,
	type RelayGet,
	type RelayKey,
	type RelayList,
	type RelayOutcome,
	type RelayPage,
	type RelayRequest,
	type RelayResult,
} from './core'
import { type HybridResult, type HybridResultRequest, type HybridRun } from './hybrid'

export interface RelayDesktopApi {
	runHybrid(request: HybridRun): Promise<DesktopResult<HybridResult>>
	getHybridResult(request: HybridResultRequest): Promise<DesktopResult<HybridResult | null>>
	resetHybrid(request: { id: string }): Promise<DesktopResult<null>>
	exportRelayConfiguration(
		request: RelayConfigExport,
	): Promise<DesktopResult<FileResult & { warnings?: string[] }>>
	importRelayConfiguration(request: RelayRequest): Promise<DesktopResult<RelayConfigImportResult>>
	applyRelayConfiguration(request: RelayConfigApply): Promise<DesktopResult<RelayConfigResult>>
	getRelayConfigurationResult(
		request: RelayResult,
	): Promise<DesktopResult<RelayConfigResult | null>>
	connectRelay(request: RelayConnect): Promise<DesktopResult<RelayConnection>>
	disconnectRelay(request: RelayRequest): Promise<DesktopResult<null>>
	listRelay(request: RelayList): Promise<DesktopResult<RelayPage>>
	getRelayResource(request: RelayGet): Promise<DesktopResult<RelayDetails>>
	changeRelayResource(request: RelayChange): Promise<DesktopResult<RelayOutcome>>
	getRelayResult(request: RelayResult): Promise<DesktopResult<RelayOutcome | null>>
	revealRelayKey(request: RelayKey): Promise<DesktopResult<AuthorizationKey>>
	copyRelayKey(request: RelayCopyKey): Promise<DesktopResult<null>>
	copyRelayEndpoint(request: RelayCopyEndpoint): Promise<DesktopResult<null>>
}
