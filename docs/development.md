# Development

## Requirements

Use Node.js 24, npm and the .NET 10 SDK. `package.json` permits Node.js 22.12 or later; CI uses Node.js 24. Native packaging needs a runner for the target operating system. The backend's pinned self-contained runtime is configured in `backend/Directory.Build.props`.

```sh
npm ci
node node_modules/electron/install.js
npm run dev
```

Run commands from the repository root. The explicit Electron install step downloads the desktop runtime and matches the desktop workflow; repeat it after `npm ci` replaces `node_modules`. A dependency install alone does not complete that step for the pinned Electron package.

`dev` builds the backend and starts Electron/Vite. Renderer changes reload through Vite; rebuild backend changes with `npm run backend:build`. `npm start` previews an existing desktop build and requires both `npm run backend:build` and `npm run build` to have completed. See [testing](testing.md) for headless Linux and packaged-app checks.

## Dependency maintenance

`package.json` records npm's install-script approvals for both esbuild versions and macOS's optional `fsevents`. The `electron-winstaller` script is denied because our Windows target is NSIS, not Squirrel. Review the scripts and update the pinned approvals when these dependencies change; `npm ci --strict-allow-scripts` checks for missing approvals.

The stable Electron packaging and updater dependencies still pull in deprecated helpers. The overrides use `@electron/asar` 4 (compatible with our Node.js minimum) and two small local adapters:

- `vendor/deep-equal` supplies Node's `isDeepStrictEqual` for `electron-updater`'s cached update metadata. It is intentionally scoped to this consumer; it is not a general replacement for Lodash equality semantics.
- `vendor/temp-rimraf` supplies Node's `fs.rm`/`rmSync` for `temp`'s literal-path cleanup, preserving its callback API and retry option. It does not implement rimraf's globbing API.

The adapters are direct dependencies so npm resolves their file paths from the project root. `.npmrc` sets `install-links=true` to install copies that can be included in packaged apps. Keep this setting for lockfile updates and clean installs. The dependency compatibility tests cover update-cache reuse, temporary-file cleanup and ASAR consumers. Remove the adapters and overrides when upstream dependencies no longer require them.

Use an npm version that supports `allowScripts` for the strict policy check; it was verified with npm 11.17. The Electron runtime download above remains an explicit step. For NuGet, CI runs `dotnet restore backend/MsgCommander.Host --locked-mode` and `dotnet restore tests/MsgCommander.TestHost --locked-mode` before building.

## Repository layout

| Path                                  | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `src/main`                            | Desktop lifecycle, workspace storage, filesystem operations and IPC registration |
| `src/preload`                         | Narrow typed bridge into the renderer                                            |
| `src/renderer/src`                    | Vue application, feature modules, shared components and styles                   |
| `src/shared/contracts`                | Runtime-validated desktop and backend contracts                                  |
| `backend/MsgCommander.Domain`         | Business rules without provider SDK dependencies                                 |
| `backend/MsgCommander.Contracts`      | Data contracts                                                                   |
| `backend/MsgCommander.Application`    | Workflows and provider ports                                                     |
| `backend/MsgCommander.Infrastructure` | Azure SDK adapters                                                               |
| `backend/MsgCommander.Host`           | Backend composition and framed protocol transport                                |
| `tests`                               | Unit, adapter, desktop and opt-in emulator checks                                |
| `scripts`                             | Current build, packaging, icon and emulator utilities                            |
| `vendor`                              | Small local adapters for deprecated transitive dependencies                      |

Open `backend/MsgCommander.slnx` for the .NET solution. NuGet uses the repository's public-source configuration and committed lock files.

## Authentication and local state

Create connections through the app; saving a profile does not connect. Connection-string profiles can keep secrets in memory or save encrypted credentials. Entra device-code profiles require a tenant ID and public-client application ID. Event Grid requires Entra; IoT Hub requires its Event Hubs-compatible connection string. See [features](features.md#connections-and-authentication) for the service-specific boundaries.

Remembered secrets are encrypted with Electron's OS-backed storage and saved as ciphertext in `workspace.json`. On Linux, the app requires a supported libsecret or KWallet backend and rejects plaintext fallback storage. Session-only access remains available. Browsing saved metadata does not decrypt credentials. Credentials and message bodies do not belong in source control.

Local settings live in the application-data workspace. Existing installations retain their supported workspace and encryption identity; see [upgrade compatibility](branding.md). Desktop tests supply isolated temporary profiles and must never use a contributor's normal workspace.

Generated output is ignored under `out/`, `artifacts/`, `release/`, `test-results/`, `bin/` and `obj/`. Editor and assistant state are also ignored. Keep generated test reports out of source commits.

## Interface work

The application uses a warm light/dark palette, bundled IBM Plex Sans and shared Vue controls. Preserve keyboard focus, accessible names, reduced-motion behavior and resizable panes. The canonical icon is documented in [branding](branding.md); `npm run icons` updates the packaging copy.

## README screenshots

After completing the development setup, generate the README's light workspace and dark message-inspector images with:

```sh
npm run backend:test-build
npm run build
node scripts/capture-screenshots.mjs
```

The script launches Electron at 1440 × 900 with the offline TestHost, creates synthetic order messages through the interface, and writes both PNGs to `docs/images/`. It uses a temporary profile that is removed afterward; no Azure credentials or live services are needed. On headless Linux, run the capture command with the display and sandbox setup described in [testing](testing.md#linux-desktop-runners).

Review both images before committing them, especially after layout, theme or message-inspector changes. Keep the README alt text accurate and use only synthetic data. These curated documentation images are tracked; ordinary test screenshots remain in ignored output folders.

## Formatting

Run `npm run format` to apply Prettier and the .NET whitespace formatter across the repository. Code uses tabs with a display width of four. YAML and generated lock files keep their format-specific indentation. `npm run format:check` verifies both formatters without changing files and runs in CI. Use short single-line comments for non-obvious reasons and constraints.
