# Testing

## Local regression

Complete [development setup](development.md#requirements), including `node node_modules/electron/install.js` after `npm ci`, then run:

```sh
npm test
npm run build
npm run test:desktop
npm run format:check
```

`npm test` builds the production backend and offline TestHost in Debug before running unit/adapter tests. `build` performs TypeScript/Vue checks and creates desktop output; it does not build the backend. Playwright then launches that output using isolated temporary user-data directories. `npm run check` combines the first three commands; formatting remains separate.

Unit tests cover runtime schemas, ownership, exact values, cancellation and receipts. Direct .NET checks exercise Application rules and Infrastructure adapters. Architecture tests enforce module boundaries and prevent renderer dependency cycles.

For focused checks, pass files explicitly, for example `npx vitest run tests/unit/dependency-compatibility.test.ts` or `npm run test:desktop -- tests/desktop/shell.spec.ts`. Tests that start a .NET host still require the corresponding backend/TestHost build.

Desktop checks cover navigation, native dialogs, messaging flows, dark/light themes, interface scaling, keyboard focus and accessibility. Some suites require explicit platform/emulator opt-ins and will be skipped otherwise. Report passed and skipped checks separately.

### Linux desktop runners

Desktop tests need a display and Chromium sandbox support. The [desktop workflow](../.github/workflows/desktop.yml) runs them with `xvfb-run --auto-servernum npm run test:desktop` on Ubuntu. It sets the downloaded `node_modules/electron/dist/chrome-sandbox` helper to root ownership and mode `4755`, and repeats that setup for `release/linux-unpacked/chrome-sandbox` before packaged tests. Follow that runner configuration when using the same headless environment; keep the app's sandbox enabled.

## Docker

The [emulator guide](../tests/emulator/README.md) documents the Microsoft Service Bus emulator and additional wire-contract fixtures. Review the required vendor licenses before enabling them. Use only disposable data and the isolated Compose projects. Tests that stop a broker verify its project identity and loopback port before acting.

After accepting the linked license terms, the Service Bus sequence in PowerShell is:

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

`test:emulator` builds the production backend and includes the Service Bus integration and recovery cases. Additional suites in that configuration are opt-in; the Event Hubs, Event Grid and Notification Hubs suites also need `npm run backend:test-build`.

| Suite                                   | Guide                                                              | Required opt-in                       |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- |
| Service Bus desktop                     | [Service Bus](../tests/emulator/README.md)                         | `COMMANDER_EMULATOR=1`                |
| Event Hubs Microsoft emulator           | [Event Hubs](../tests/emulator/event-hubs/README.md)               | `COMMANDER_EVENTHUBS_EMULATOR=1`      |
| Event Grid HTTP contract fixture        | [Event Grid](../tests/emulator/event-grid/README.md)               | `COMMANDER_EVENTGRID_DOCKER=1`        |
| Notification Hubs HTTP contract fixture | [Notification Hubs](../tests/emulator/notification-hubs/README.md) | `COMMANDER_NOTIFICATIONHUBS_DOCKER=1` |

Event Hubs uses Microsoft's emulator. Event Grid and Notification Hubs use repository-owned contract simulators. None of these suites establishes live Azure interoperability. Use the individual commands in each guide to avoid also running Service Bus tests against a broker you have not started. Clear opt-in variables, or start a new terminal, before returning to the ordinary regression suite.

## Packaged application

Create a native package with `npm run package`, then run the shell checks with `COMMANDER_PACKAGED=1`. Set `COMMANDER_PACKAGED_EXECUTABLE` when using a non-default output location. Example on macOS ARM64:

```sh
COMMANDER_PACKAGED=1 npm run test:desktop -- tests/desktop/shell.spec.ts
```

PowerShell, with a Windows package in the default output directory:

```powershell
$env:COMMANDER_PACKAGED = '1'
$env:COMMANDER_PACKAGED_EXECUTABLE = "$PWD/release/win-unpacked/msg-commander.exe"
npm run test:desktop -- tests/desktop/shell.spec.ts
Remove-Item Env:COMMANDER_PACKAGED, Env:COMMANDER_PACKAGED_EXECUTABLE
```

The [GitHub workflow](../.github/workflows/desktop.yml) runs the desktop suite against the native package on each matrix runner; tests that require offline fixtures are skipped in packaged mode. Every desktop launch uses an isolated profile, which also disables update checks. Signed automatic upgrades need the separate [release qualification](releasing.md#saved-connections-and-upgrade-qualification).

## Recovery, endurance and installer checks

The [Service Bus guide](../tests/emulator/README.md#isolated-recovery-and-longer-runs) provides the isolated brokers, environment setup and cleanup commands. Run workloads against the same broker sequentially.

| Check                                     | Command or test                                                                               | Additional setup                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Six Service Bus wire-fault cases          | `npm run test:emulator:recovery`                                                              | Default broker; `COMMANDER_RECOVERY_ISOLATED=1` selects the recovery broker.                  |
| Extended recovery/broker restart          | `tests/emulator/extended-recovery.test.ts`                                                    | Recovery Compose project and `COMMANDER_RECOVERY_EXTENDED=1`.                                 |
| One- to two-hour client outage            | `tests/emulator/long-outage.test.ts`                                                          | Outage Compose project, `COMMANDER_LONG_OUTAGE=1` and `COMMANDER_OUTAGE_SECONDS=3600`–`7200`. |
| Windows packaged backend/network recovery | `tests/desktop/beta-recovery-emulator.spec.ts`, `tests/desktop/beta-network-emulator.spec.ts` | `COMMANDER_PACKAGED=1`, `COMMANDER_EMULATOR=1` and `COMMANDER_PACKAGED_EXECUTABLE`.           |
| Windows test-job endurance                | `npm run test:emulator:soak`                                                                  | Same package/emulator settings, plus `COMMANDER_SOAK=1`.                                      |
| Windows listener endurance                | `tests/desktop/listener-soak-emulator.spec.ts`                                                | Same package/emulator settings, plus `COMMANDER_LISTENER_SOAK=1`.                             |
| Windows device scaling                    | `tests/desktop/windows-scaling.spec.ts`                                                       | `COMMANDER_WINDOWS_SCALING=1` and `COMMANDER_PACKAGED_EXECUTABLE`.                            |

Both endurance drivers accept `COMMANDER_SOAK_SECONDS=60`–`7200`. `COMMANDER_RECOVERY_HOST` can point backend recovery checks at a packaged host executable; otherwise they use the Debug production host.

`tests/desktop/windows-installer.spec.ts` is a separate, explicit installation test. It requires Windows, `COMMANDER_INSTALLER=1`, `COMMANDER_PREVIOUS_INSTALLER`, `COMMANDER_CANDIDATE_INSTALLER`, the actual `COMMANDER_PREVIOUS_VERSION`, and the default Service Bus broker. Keep each installer alongside its corresponding `win-unpacked` directory. The test refuses to replace an existing product installation or shortcuts. `COMMANDER_INSTALLER_RECOVERY=1` adds recovery checks and requires a previous installer from 0.62.1 or later. Inspect the test before using a disposable Windows test environment.

## Live Azure and evidence

Use disposable namespaces, resources and synthetic messages. Define the intended service actions and test identities before starting. Never run destructive tests against personal or production connections. Retain the exact source revision, package identity, platform, command and observed outcome with qualification results.

Test traces, screenshots and runtime reports belong under ignored `artifacts/`, `test-results/` or `playwright-report/`. Historical run records are available in Git history; the working tree documents the current implementation.
