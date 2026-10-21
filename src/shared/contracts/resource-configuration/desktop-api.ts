import {
	type MessagingConfigRequest,
	type MessagingConfigImportResult,
	type MessagingConfigExport,
	type MessagingConfigApply,
	type MessagingConfigResult,
	type MessagingConfigResultRequest,
} from '../resource-configuration'
import { type DesktopResult } from '../platform/desktop'
import { type FileResult } from '../../message-files'

export interface ResourceConfigurationDesktopApi {
	importMessagingConfiguration(
		request: MessagingConfigRequest,
	): Promise<DesktopResult<MessagingConfigImportResult>>
	exportMessagingConfiguration(
		request: MessagingConfigExport,
	): Promise<DesktopResult<FileResult & { warnings?: string[] }>>
	applyMessagingConfiguration(
		request: MessagingConfigApply,
	): Promise<DesktopResult<MessagingConfigResult>>
	getMessagingConfigurationResult(
		request: MessagingConfigResultRequest,
	): Promise<DesktopResult<MessagingConfigResult | null>>
}
