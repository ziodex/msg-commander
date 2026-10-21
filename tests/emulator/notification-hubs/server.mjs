import http from 'node:http'

const root =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture'
const hubId = root + '/notificationHubs/alerts'
let hub, mode, stats
function reset() {
	hub = {
		id: hubId,
		name: 'alerts',
		location: 'westeurope',
		tags: { purpose: 'fixture' },
		properties: {
			registrationTtl: '30.00:00:00',
			futureSetting: 'preserved',
			gcmCredential: { properties: { googleApiKey: 'DOCKER-SECRET-LEGACY' } },
			authorizationRules: [{ name: 'embedded', primaryKey: 'DOCKER-SECRET-KEY' }],
		},
	}
	mode = 'normal'
	stats = { reads: 0, writes: 0, lastPatch: null }
}
reset()
const send = (res, code, value) => {
	res.writeHead(code, { 'content-type': 'application/json' })
	res.end(JSON.stringify(value))
}
http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://fixture')
		if (url.pathname === '/__reset' && req.method === 'POST') {
			reset()
			return send(res, 200, { ok: true })
		}
		if (url.pathname === '/__mode' && req.method === 'POST') {
			mode = url.searchParams.get('value')
			return send(res, 200, { ok: true })
		}
		if (url.pathname === '/__stats') return send(res, 200, stats)
		if (
			req.headers.authorization !== 'Bearer fixture-docker-token' ||
			req.headers['x-fixture-authority'] !== 'management.azure.com'
		)
			return send(res, 401, {})
		if (url.searchParams.get('api-version') !== '2023-09-01') return send(res, 400, {})
		const path = decodeURIComponent(url.pathname)
		if (req.method === 'GET') {
			stats.reads++
			if (path === root)
				return send(res, 200, {
					id: root,
					location: 'westeurope',
					properties: { serviceBusEndpoint: 'https://fixture.servicebus.windows.net/' },
				})
			if (path === root + '/notificationHubs') return send(res, 200, { value: [hub] })
			if (path === hubId) return send(res, 200, hub)
			if (path === root + '/authorizationRules' || path === hubId + '/authorizationRules')
				return send(res, 200, { value: [] })
		}
		if (req.method === 'PATCH' && path === hubId) {
			const chunks = []
			for await (const chunk of req) chunks.push(chunk)
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			if (Object.keys(body).some((key) => !['properties', 'tags'].includes(key)))
				return send(res, 400, {})
			stats.writes++
			stats.lastPatch = body
			if (body.tags) hub.tags = body.tags
			Object.assign(hub.properties, body.properties)
			if (mode === 'disconnect-write') {
				req.socket.destroy()
				return
			}
			if (mode === 'slow-write') await new Promise((resolve) => setTimeout(resolve, 2000))
			return send(res, 200, hub)
		}
		return send(res, 404, {})
	} catch {
		if (!res.destroyed) send(res, 500, {})
	}
}).listen(5303, '0.0.0.0', () =>
	console.log('Notification Hubs synthetic ARM fixture ready on 5303'),
)
