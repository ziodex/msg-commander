import { type CodecRequest, type CodecResult } from '../../body-codecs'
import { type DesktopResult } from '../platform/desktop'
import { type FileResult } from '../../message-files'

export interface BodyToolsDesktopApi {
	convertBody(input: CodecRequest): Promise<DesktopResult<CodecResult>>
	openCodecBody(input: {
		id: string
	}): Promise<DesktopResult<{ cancelled: boolean; contentBase64?: string; fileName?: string }>>
	saveCodecBody(input: { id: string; resultId: string }): Promise<DesktopResult<FileResult>>
	discardCodecBody(resultId: string): Promise<DesktopResult<null>>
}
