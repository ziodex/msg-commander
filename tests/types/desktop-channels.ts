import { z } from 'zod'
import type { IpcRegistrar } from '../../src/main/ipc/types'
import type { PreloadInvoker } from '../../src/preload/types'
import type { DesktopResult } from '../../src/shared/contracts'

declare const register: IpcRegistrar
declare const invoke: PreloadInvoker

// These assertions run during typecheck, without executing Electron calls.
// @ts-expect-error Unknown channels cannot be invoked.
invoke('commander:nonexistent-channel', {})
// @ts-expect-error The channel determines its input, not the caller.
invoke('commander:sb-connect', { wrongInput: true })
// @ts-expect-error The channel determines its reply.
const wrongReply: Promise<DesktopResult<number>> = invoke('commander:bootstrap')
// @ts-expect-error A known channel cannot register an unrelated request schema.
register('commander:cancel', z.object({ wrongInput: z.boolean() }), () => {})
// @ts-expect-error The handler must return the channel's declared value.
register('commander:bootstrap', z.undefined(), async () => 12345)
// @ts-expect-error Zero-argument channels cannot accept arbitrary input.
invoke('commander:bootstrap', { wrongInput: true })
// Correct handlers and invocations must remain usable.
register('commander:cancel', z.string(), () => {})
invoke('commander:bootstrap')
void wrongReply
