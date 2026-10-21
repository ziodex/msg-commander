# Testing

## Local regression

```sh
npm test
npm run build
npm run test:desktop
```

`npm test` builds the production backend and the offline TestHost before running unit/adapter tests. `build` performs TypeScript/Vue checks and creates desktop output. Playwright then launches that output using isolated temporary user-data directories. Run the three commands in order after a clean checkout; `npm run check` combines them.

Unit tests cover runtime schemas, ownership, exact values, cancellation and receipts. Direct .NET checks exercise Application rules and Infrastructure adapters. Architecture tests enforce module boundaries and prevent renderer dependency cycles.

Desktop checks cover navigation, native dialogs, messaging flows, dark/light themes, interface scaling, keyboard focus and accessibility. Some suites require explicit platform/emulator opt-ins and will be skipped otherwise. Report passed and skipped checks separately.

## Docker

The [emulator guide](../tests/emulator/README.md) documents the Microsoft Service Bus emulator and additional wire-contract fixtures. Review the required vendor licenses before enabling them. Use only disposable data and the isolated Compose projects. Tests that stop a broker verify its project identity and loopback port before acting.

```sh
npm run emulator:up
npm run test:emulator
npm run test:emulator:desktop
npm run emulator:down
```

Starting the Service Bus emulator requires the explicit `ACCEPT_EULA=Y` setting described in that guide. Other service fixture suites are contract simulators; they do not establish cloud interoperability.

## Packaged application

Create a native package with `npm run package`, then run the shell checks with `COMMANDER_PACKAGED=1`. Set `COMMANDER_PACKAGED_EXECUTABLE` when using a non-default output location. Example on macOS ARM64:

```sh
COMMANDER_PACKAGED=1 npm run test:desktop -- tests/desktop/shell.spec.ts
```

The [GitHub workflow](../.github/workflows/desktop.yml) runs packaged launch checks on the native build matrix. Windows installer lifecycle, recovery, device-scale and longer-running emulator checks require the explicit environment flags read by their test files.

## Live Azure and evidence

Use disposable namespaces, resources and synthetic messages. Define the intended service actions and test identities before starting. Never run destructive tests against personal or production connections. Retain the exact source revision, package identity, platform, command and observed outcome with qualification results.

Test traces, screenshots and runtime reports belong under ignored `artifacts/`, `test-results/` or `playwright-report/`. Historical run records are available in Git history; the working tree documents the current implementation.
