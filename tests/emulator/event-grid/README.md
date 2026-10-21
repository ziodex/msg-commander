# Event Grid Docker contract checks

This fixture tests the production HTTP adapter over real sockets. It implements the specific namespace, publishing and pull-delivery responses exercised by the tests; it is not an Azure Event Grid emulator and does not qualify service parity, TLS, Entra sign-in, RBAC, cloud provisioning or push delivery.

The test-only transport redirects the two expected Azure authorities to this loopback fixture. Production endpoint validation, HTTPS, resource scoping, request versions and redirect/retry policy remain unchanged. Authentication uses a synthetic token. The fixture is separate from the Service Bus and Event Hubs emulators.

```powershell
docker compose -f tests/emulator/event-grid/compose.yaml up -d
npm run backend:test-build
$env:COMMANDER_EVENTGRID_DOCKER='1'
npx vitest run --config vitest.emulator.config.ts tests/emulator/event-grid.test.ts
```

Coverage includes reviewed ARM updates, bounded CloudEvents publishing, exact JSON numbers, received handles, partial settlements, broker-token filtering, connection loss after dispatch, truncated response bodies, cancellation after receive dispatch, complete responses after cancellation and explicit reconnect. Receipt replay must not issue another request. Disconnect must not silently settle held events.

The fixture preserves raw JSON slices to avoid rounding event data. Its pull routes and response shapes follow the pinned [namespace receive REST contract](https://learn.microsoft.com/en-us/rest/api/eventgrid/namespace/receive-cloud-events/receive-cloud-events?view=rest-eventgrid-namespace-2024-06-01). It binds port 5302 to loopback and stores synthetic state only in memory; each test run explicitly resets its own fixture.

```powershell
docker compose -f tests/emulator/event-grid/compose.yaml down
```
