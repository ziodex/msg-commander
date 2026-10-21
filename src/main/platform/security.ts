export function trustedRendererUrl(candidate: string, developmentUrl?: string): boolean {
	try {
		const url = new URL(candidate)
		if (developmentUrl) {
			const development = new URL(developmentUrl)
			return url.origin === development.origin && url.pathname === '/'
		}
		return url.protocol === 'commander:' && url.host === 'app' && url.pathname === '/index.html'
	} catch {
		return false
	}
}

export function secureStorageAvailable(
	platform: string,
	available: boolean,
	backend?: string,
): boolean {
	return (
		available &&
		(platform !== 'linux' ||
			['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend ?? ''))
	)
}
