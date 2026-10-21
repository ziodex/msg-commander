# Local Service Bus integration

Complete the repository's [development setup](../../docs/development.md#requirements) first. These checks require Docker with Compose, Linux containers and free localhost ports 5672 and 5300. They use the production .NET host and Azure SDK; recovery checks can also target the host bundled in a package. No Azure account is used.

Review the [Service Bus emulator license](https://github.com/Azure/azure-service-bus-emulator-installer/blob/main/EMULATOR_EULA.txt) and [SQL Server Linux license](https://go.microsoft.com/fwlink/?LinkId=746388). In PowerShell:

```powershell
$env:ACCEPT_EULA = 'Y'
npm run emulator:up
npm run test:emulator
npm run build
$env:COMMANDER_EMULATOR = '1'
npm run test:emulator:desktop
npm run emulator:down
Remove-Item Env:COMMANDER_EMULATOR
```

The setup creates only the `msg-commander-emulator` Compose project, binds AMQP/management to loopback, keeps SQL private, generates a local SQL password in ignored `.env`, and waits for health. `down` stops/removes only that project's containers/network. Broker data is disposable; do not use it for stored work. Tests run sequentially with synthetic messages. Avoid other clients during a run.

In the app choose **New connection → Local emulator**. Defaults: hostname `localhost`, management port `5300`, and the emulator's public development connection string. Save, then connect. AMQP uses TCP; Azure profiles retain WebSockets. For a non-default AMQP port, include it in the connection string endpoint; the management port is separate. The endpoint must match the profile hostname.

See Microsoft's [current setup](https://learn.microsoft.com/en-us/azure/service-bus-messaging/test-locally-with-service-bus-emulator) and [limitations](https://learn.microsoft.com/en-us/azure/service-bus-messaging/overview-emulator). Entra/RBAC, ARM, partitioning, WebSockets, cloud limits and other Azure services are not qualified by this suite.

The Service Bus and SQL images are pinned by digest in the three Service Bus Compose files. Update them deliberately and rerun the affected suites; retain fresh run evidence under ignored artifacts.

Other services have separate setup and opt-in flags:

- [Event Hubs Microsoft emulator](event-hubs/README.md): AMQP `5673`, management `5301`.
- [Event Grid HTTP contract fixture](event-grid/README.md): HTTP `5302`.
- [Notification Hubs HTTP contract fixture](notification-hubs/README.md): HTTP `5303`.

These guides run individual test files and build the offline TestHost used to compose their adapters. `npm run test:emulator` also runs Service Bus cases, so it is not a substitute for an individual fixture command when the Service Bus broker is stopped.

The backend suite also exercises concurrent test workers, shared send/receive limits, negotiated batch splitting, latency samples, cancellation and selected-session batches. To check the desktop test tools, set `COMMANDER_EMULATOR=1`, build the app, then run `npx playwright test tests/desktop/test-tools-emulator.spec.ts`. Set `COMMANDER_PACKAGED_EXECUTABLE` to a Windows package executable to exercise that bundle. Both suites create their own queues and remove them afterward.

Recovery and paced Windows endurance checks are indexed in [the testing guide](../../docs/testing.md#recovery-endurance-and-installer-checks). `npm run test:emulator:recovery` runs the six wire-fault cases; the packaged network tests and opt-in soak run separately. Run Docker suites one at a time to keep namespace contention distinct from the injected fault. The proxy affects only its test client; it never pauses or disconnects the shared Docker containers.

### Isolated recovery and longer runs

`compose.recovery.yaml` creates a separate `msg-commander-recovery` project and SQL instance on loopback AMQP 15672/management 15300. It reuses the locally accepted license configuration in `.env`. The opt-in extended suite verifies the exact project, service and port binding before stopping/restarting that broker. It never restarts `msg-commander-emulator` or unrelated containers.

```powershell
docker compose -f tests/emulator/compose.recovery.yaml up -d
npm run backend:build
$env:COMMANDER_RECOVERY_EXTENDED = '1'
# To qualify a package, point this at its resources/backend/MsgCommander.Host.exe.
$env:COMMANDER_RECOVERY_HOST = "$PWD/release/win-unpacked/resources/backend/MsgCommander.Host.exe"
npx vitest run --config vitest.emulator.config.ts tests/emulator/extended-recovery.test.ts
Remove-Item Env:COMMANDER_RECOVERY_EXTENDED
```

The extended cases cover a 75-second outage beyond a one-minute message lock, session renewal with a lost acknowledgement, listener renewal/stop/resume, lost listener settlement acknowledgement, interrupted concurrent sessions, and a broker restart. Acknowledgement-loss requests allow the configured 20-second SDK timeout to return a truthful receipt; no mutation is repeated. Restart evidence records whether the disposable emulator retained messages and does not establish Azure durability.

For the six fault cases on the isolated broker, set `COMMANDER_RECOVERY_ISOLATED=1`. Stop extended fault tests before starting a listener endurance run on that same broker. `COMMANDER_RECOVERY_HOST` is optional: omit it to use the Debug production host; set it only when the selected package has already been built.

Both endurance drivers accept `COMMANDER_SOAK_SECONDS` from 60 to 7200 and save uniquely named raw/progress files under `artifacts/beta-recovery/`. Test-job limits in the product remain unchanged. The original driver uses public preload calls for concurrent send/complete/peek/inspect/reconnect cycles. The listener driver uses the actual renderer connection/listener stores, continuously renders counters/history/session rows, and periodically opens JSON inspectors and closes/reopens the listener dialog.

```powershell
$env:COMMANDER_PACKAGED = '1'
$env:COMMANDER_EMULATOR = '1'
$env:COMMANDER_PACKAGED_EXECUTABLE = "$PWD/release/win-unpacked/msg-commander.exe"
$env:COMMANDER_SOAK_SECONDS = '3600'
$env:COMMANDER_SOAK = '1'
npx playwright test tests/desktop/beta-soak-emulator.spec.ts
# Separately, after recovery/restart tests have finished:
$env:COMMANDER_RECOVERY_ISOLATED = '1'
$env:COMMANDER_LISTENER_SOAK = '1'
npx playwright test tests/desktop/listener-soak-emulator.spec.ts
docker compose -f tests/emulator/compose.recovery.yaml down
```

Keep workloads on a given broker sequential. Independent brokers can run concurrently, but the host is shared: sampled resource limits are workload checks, not a capacity benchmark or proof of leak freedom.

After the run, clear the `COMMANDER_*` test variables or use a new terminal before returning to normal desktop checks. Stop the default broker separately with `npm run emulator:down` if it is still running.

### Prolonged client outage

`compose.outage.yaml` owns a third disposable broker on loopback AMQP 25672/management 25300. It reuses the accepted local license configuration. Start it with `docker compose -f tests/emulator/compose.outage.yaml up -d`, set `COMMANDER_LONG_OUTAGE=1`, `COMMANDER_OUTAGE_SECONDS=3600` and, if testing a package, `COMMANDER_RECOVERY_HOST`, then run `npx vitest run --config vitest.emulator.config.ts tests/emulator/long-outage.test.ts`. The allowed outage duration is 3600–7200 seconds. Stop only this project afterward with the same compose file and `down`.

The client proxies cut both AMQP and management for the selected duration while local delivery inspection and backend responsiveness are checked every 30 seconds. The test uses a one-hour message lifetime, so the original broker message expires during the outage. Recovery must reject its stale settlement, clear local handles on explicit reconnect, and send/receive/complete a fresh message without replay. This is distinct from the 75-second lock-expiry/redelivery check and makes no durability claim.
