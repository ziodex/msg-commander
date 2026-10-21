# Notification Hubs management contract fixture

This disposable Node HTTP fixture runs in Docker, bound to loopback port 5303. It is a synthetic contract fixture, not an Azure Notification Hubs emulator. It contains synthetic credentials only.

Complete [development setup](../../../docs/development.md#requirements), then run this individual fixture test from the repository root in PowerShell:

```powershell
docker compose -f tests/emulator/notification-hubs/compose.yaml up -d
npm run backend:test-build
$env:COMMANDER_NOTIFICATIONHUBS_DOCKER = '1'
npx vitest run --config vitest.emulator.config.ts tests/emulator/notification-hubs.test.ts
docker compose -f tests/emulator/notification-hubs/compose.yaml down
Remove-Item Env:COMMANDER_NOTIFICATIONHUBS_DOCKER
```

The TestHost uses the production ARM adapter and a test-only HTTP handler that redirects only `https://management.azure.com` to this fixture. Production endpoint validation, authentication configuration and retry settings are unchanged. The checks cover reviewed updates, scoped provider patches, secret filtering, receipt replay, dropped write replies, cancellation and reconnects. They do not qualify Entra/RBAC, live Azure behavior, provider authentication or device delivery.
