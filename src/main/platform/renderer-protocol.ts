import { net, protocol, session } from 'electron'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
export function configureRendererProtocol(rendererRoot: string) {
	protocol.handle('commander', async (request) => {
		const url = new URL(request.url)
		const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
		if (url.host !== 'app' || !file.startsWith(rendererRoot + sep))
			return new Response('Not found', { status: 404 })
		const response = await net.fetch(pathToFileURL(file).toString())
		const headers = new Headers(response.headers)
		headers.set(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
		)
		return new Response(response.body, { status: response.status, headers })
	})
	session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
		callback(false),
	)
	session.defaultSession.setPermissionCheckHandler(() => false)
}
