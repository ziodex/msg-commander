import type { ProfileInput } from '../../../shared/contracts'
import type { HybridRun } from '../../../shared/contracts/relay/hybrid'
import { Backend, HostError } from '../../platform/backend'
export class HybridController {
	private generation = 0
	private resetting: Promise<void> = Promise.resolve()
	constructor(
		private backend: Backend,
		private onReset: () => void,
	) {}
	forget() {
		this.generation++
		this.onReset()
	}
	reset() {
		this.forget()
		this.resetting = this.resetting
			.catch(() => {})
			.then(async () => {
				if (this.backend.status.state === 'ready')
					await this.backend.request('hybrid.reset', {}, { timeout: 45000 })
			})
		return this.resetting
	}
	async run(request: HybridRun, profile: ProfileInput | undefined, signal: AbortSignal) {
		if (!profile || profile.id !== request.profileId || profile.service !== 'relay')
			throw new HostError('INVALID_PROFILE', 'Choose a Relay profile.')
		const generation = this.generation
		await this.resetting
		if (generation !== this.generation || signal.aborted)
			throw new HostError('CANCELLED', 'Hybrid Connection job cancelled before starting.')
		try {
			return await this.backend.request(
				'hybrid.run',
				{ request, profile },
				{ signal, timeout: (request.maxSeconds + 45) * 1000, waitForCancellation: true },
			)
		} catch (error) {
			if (
				error instanceof HostError &&
				['TIMEOUT', 'BACKEND_UNAVAILABLE', 'CANCELLED', 'INVALID_RESPONSE'].includes(
					error.code,
				)
			)
				throw new HostError(
					'OUTCOME_UNKNOWN',
					'The Hybrid Connection result was interrupted. The peer may have received bytes. Recover the result before sending again; nothing was retried.',
				)
			throw error
		}
	}
}
