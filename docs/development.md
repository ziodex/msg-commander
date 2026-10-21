# Development

## Requirements

Use Node.js 24, npm and the .NET 10 SDK. `package.json` permits Node.js 22.12 or later; CI uses Node.js 24. Native packaging needs a runner for the target operating system. The backend's pinned self-contained runtime is configured in `backend/Directory.Build.props`.

```sh
npm ci
npm run dev
```

`dev` builds the backend and starts Electron/Vite. Renderer changes reload through Vite; rebuild backend changes with `npm run backend:build`. `npm start` previews the existing desktop build.

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

Open `backend/MsgCommander.slnx` for the .NET solution. NuGet uses the repository's public-source configuration and committed lock files.

## Authentication and local state

Create connections through the app. Session-only credentials stay in memory. Remembered credentials use supported OS-protected storage and are decrypted only when required. Browsing saved connection metadata does not open the credential store. Credentials and message bodies do not belong in source control.

Local settings live in the application-data workspace. Existing installations retain their supported workspace and encryption identity; see [upgrade compatibility](branding.md). Desktop tests supply isolated temporary profiles and must never use a contributor's normal workspace.

Generated output is ignored under `out/`, `artifacts/`, `release/`, `test-results/`, `bin/` and `obj/`. Editor and assistant state are also ignored. Keep generated test reports out of source commits.

## Interface work

The application uses a warm light/dark palette, bundled IBM Plex Sans and shared Vue controls. Preserve keyboard focus, accessible names, reduced-motion behavior and resizable panes. The canonical icon is documented in [branding](branding.md); `npm run icons` updates the packaging copy.

## Formatting

Run `npm run format` to apply Prettier and the .NET whitespace formatter across the repository. Code uses tabs with a display width of four. YAML and generated lock files keep their format-specific indentation. `npm run format:check` verifies both formatters without changing files and runs in CI. Use short single-line comments for non-obvious reasons and constraints.
