# Event Hubs Docker checks

Use the [Microsoft emulator setup](https://learn.microsoft.com/en-us/azure/event-hubs/test-locally-with-event-hub-emulator) and review its linked Microsoft Software License Terms. With Docker running and those terms accepted:

```powershell
$env:ACCEPT_EULA='Y'
docker compose -f tests/emulator/event-hubs/compose.yaml up -d
npm run backend:test-build
$env:COMMANDER_EVENTHUBS_EMULATOR='1'
npx vitest run --config vitest.emulator.config.ts tests/emulator/event-hubs.test.ts
```

Ports 5673 and 5301 are bound to loopback, separate from the Service Bus emulator. The test uses synthetic events in the two configured hubs. Data lasts until container restart; each run records a fixed starting position and reads only its own appended events.

This test composes the Application connection owner, send/read/listen services and production envelope/position/batch/receiver adapters. Its test-only gateway creates SDK clients with AMQP/TCP and the emulator connection string. The production application continues to validate Azure Public Cloud endpoints and use AMQP WebSockets. Docker does not qualify that cloud transport, IoT connectivity, ARM administration, Entra permissions, retention expiration or cloud service parity. The [emulator limitations](https://learn.microsoft.com/en-us/azure/event-hubs/overview-emulator) apply.

```powershell
docker compose -f tests/emulator/event-hubs/compose.yaml down
```
