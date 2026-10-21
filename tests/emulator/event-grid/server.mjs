import { createServer } from 'node:http'

// A deterministic HTTP contract fixture, not an Event Grid service emulator.
const root =
	'/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture'
const hostname = 'fixture.westeurope-1.eventgrid.azure.net'
let state
function reset() {
	state = {
		scenario: 'normal',
		events: [],
		cursor: 0,
		leases: new Map(),
		next: 0,
		publishRequests: 0,
		receiveRequests: 0,
		settleRequests: 0,
		headersSent: 0,
		adminWrites: 0,
		retention: 7,
	}
}
reset()
async function readBody(request) {
	const chunks = []
	for await (const part of request) chunks.push(part)
	return Buffer.concat(chunks).toString('utf8')
}
function reply(response, value, status = 200) {
	const body = JSON.stringify(value)
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(body),
	})
	response.end(body)
}
// Keep each original JSON slice: JSON.parse/stringify would round large event data numbers.
function batchSlices(text) {
	if (!text.trimStart().startsWith('[')) return [text]
	const result = []
	let depth = 0,
		quoted = false,
		escape = false,
		start = -1
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (quoted) {
			if (escape) escape = false
			else if (c === '\\') escape = true
			else if (c === '"') quoted = false
			continue
		}
		if (c === '"') {
			quoted = true
			continue
		}
		if (c === '{') {
			if (depth++ === 0) start = i
		} else if (c === '}' && --depth === 0) result.push(text.slice(start, i + 1))
	}
	return result
}
const topic = () => ({
	id: root + '/topics/orders',
	name: 'orders',
	location: 'westeurope',
	properties: {
		provisioningState: 'Succeeded',
		inputSchema: 'CloudEventSchemaV1_0',
		publisherType: 'Custom',
		eventRetentionInDays: state.retention,
		futureProperty: 'preserve',
	},
})
const subscription = () => ({
	id: root + '/topics/orders/eventSubscriptions/fulfillment',
	name: 'fulfillment',
	properties: {
		provisioningState: 'Succeeded',
		eventDeliverySchema: 'CloudEventSchemaV1_0',
		filtersConfiguration: { includedEventTypes: null, filters: [] },
		deliveryConfiguration: {
			deliveryMode: 'Queue',
			queue: {
				receiveLockDurationInSeconds: 60,
				maxDeliveryCount: 10,
				eventTimeToLive: 'P1D',
			},
		},
	},
})
createServer(async (request, response) => {
	try {
		const url = new URL(request.url, 'http://fixture')
		if (url.pathname === '/health') return reply(response, { ready: true })
		if (url.pathname === '/__fixture/control') {
			const body = await readBody(request)
			const value = JSON.parse(body)
			if (value.reset) reset()
			if (value.scenario) state.scenario = value.scenario
			return reply(response, { ready: true })
		}
		if (url.pathname === '/__fixture/stats')
			return reply(
				response,
				Object.fromEntries(
					Object.entries(state).filter(([key]) => !['events', 'leases'].includes(key)),
				),
			)
		if (request.headers.authorization !== 'Bearer fixture-docker-token')
			return reply(response, { error: { code: 'Unauthorized' } }, 401)
		const authority = request.headers['x-fixture-authority']
		if (
			authority === 'management.azure.com' &&
			url.searchParams.get('api-version') === '2025-02-15'
		) {
			if (request.method === 'GET' && url.pathname === root)
				return reply(response, {
					id: root,
					name: 'fixture',
					location: 'westeurope',
					properties: {
						provisioningState: 'Succeeded',
						topicsConfiguration: { hostname },
					},
				})
			if (request.method === 'GET' && url.pathname === root + '/topics')
				return reply(response, { value: [topic()] })
			if (request.method === 'GET' && url.pathname === root + '/topics/orders')
				return reply(response, topic())
			if (
				request.method === 'GET' &&
				url.pathname === root + '/topics/orders/eventSubscriptions/fulfillment'
			)
				return reply(response, subscription())
			if (request.method === 'PATCH' && url.pathname === root + '/topics/orders') {
				const body = await readBody(request)
				state.retention = JSON.parse(body).properties.eventRetentionInDays
				state.adminWrites++
				return reply(response, topic())
			}
		}
		if (
			authority === hostname &&
			request.method === 'POST' &&
			url.searchParams.get('api-version') === '2024-06-01'
		) {
			const body = await readBody(request)
			if (url.pathname === '/topics/orders:publish') {
				state.publishRequests++
				state.events.push(...batchSlices(body))
				return reply(response, {})
			}
			const action = url.pathname.match(
				/^\/topics\/orders\/eventsubscriptions\/fulfillment:(receive|acknowledge|release|reject|renewLock)$/,
			)?.[1]
			if (action === 'receive') {
				state.receiveRequests++
				const count = Number(url.searchParams.get('maxEvents'))
				const rows = []
				for (let i = 0; i < count && state.cursor < state.events.length; i++) {
					const raw = state.events[state.cursor++],
						token = 'DOCKER-SECRET-LOCK-' + ++state.next
					state.leases.set(token, raw)
					rows.push(
						'{"brokerProperties":' +
							JSON.stringify({ lockToken: token, deliveryCount: 1 }) +
							',"event":' +
							raw +
							'}',
					)
				}
				const payload = '{"value":[' + rows.join(',') + ']}'
				if (state.scenario === 'slow-receive')
					return setTimeout(() => {
						if (!response.destroyed) {
							response.writeHead(200, { 'content-type': 'application/json' })
							response.end(payload)
						}
					}, 2000)
				response.writeHead(200, {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
				})
				response.flushHeaders()
				state.headersSent++
				return state.scenario === 'delayed-body'
					? setTimeout(() => response.end(payload), 300)
					: response.end(payload)
			}
			if (action) {
				state.settleRequests++
				const tokens = JSON.parse(body).lockTokens
				const failed = [],
					succeeded = []
				for (const [i, token] of tokens.entries()) {
					if (
						!state.leases.has(token) ||
						(state.scenario === 'partial-settle' && i === 0)
					)
						failed.push({
							lockToken: token,
							error: { code: 'TokenLost', message: 'DOCKER-SECRET-DETAIL' },
						})
					else succeeded.push(token)
					if (action !== 'renewLock') state.leases.delete(token)
				}
				if (state.scenario === 'disconnect-settle') return request.socket.destroy()
				const payload = JSON.stringify({
					succeededLockTokens: succeeded,
					failedLockTokens: failed,
				})
				if (state.scenario === 'truncate-settle') {
					response.writeHead(200, {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload) + 50,
					})
					return response.end(payload.slice(0, 20))
				}
				return reply(response, { succeededLockTokens: succeeded, failedLockTokens: failed })
			}
		}
		reply(response, { error: { code: 'FixtureRouteRejected' } }, 400)
	} catch {
		if (!response.headersSent) reply(response, { error: { code: 'FixtureInputRejected' } }, 400)
		else response.destroy()
	}
}).listen(5302, '0.0.0.0')
