# Packaging

Build on the target operating system. Supported targets are `darwin-arm64`, `darwin-x64`, `linux-x64` and `win32-x64`.

```sh
npm ci
npm run package
```

`package` type-checks/builds the desktop, publishes the .NET backend with locked dependencies, then runs electron-builder. It downloads the Electron distribution for the package as needed. For an unpacked application use `npm run package:dir`. Pass a supported target after `--`, for example `npm run package -- win32-x64` or `npm run package -- win32-x64 --dir` on a Windows x64 runner.

The publisher clears its verified backend output folder before publishing so removed assemblies cannot survive an earlier build. The app includes the self-contained backend, project license, third-party notices and bundled font licenses. A separate .NET installation is not required by the package.

## Outputs

| Platform | Outputs                                              |
| -------- | ---------------------------------------------------- |
| macOS    | DMG and ZIP containing Msg Commander.app             |
| Linux    | AppImage with the msg-commander executable           |
| Windows  | NSIS installer with the msg-commander.exe executable |

Default output is `release/`. `COMMANDER_PACKAGE_OUTPUT` selects a different output directory. Backend publish files are under `artifacts/backend/<rid>/`, where the runtime IDs are `osx-arm64`, `osx-x64`, `linux-x64` and `win-x64`. Installer names use `Msg-Commander-<version>-<os>-<arch>.<ext>`; Windows filenames use `win`, for example `Msg-Commander-0.63.0-win-x64.exe`.

Unpacked executables are under `release/win-unpacked/msg-commander.exe`, `release/linux-unpacked/msg-commander`, or `release/mac[-arm64]/Msg Commander.app/Contents/MacOS/Msg Commander`. `--dir` produces an unpacked app without the distributable installer/archive set needed for a release.

## Signing and publication

Without `COMMANDER_RELEASE=1`, macOS packaging uses an ad-hoc identity and disables notarization. Windows installers are unsigned unless signing is configured. The release workflow sets `COMMANDER_RELEASE=1`, requires code signing, enables macOS notarization and supplies the platform credentials. See the [signing secrets](releasing.md#signing-secrets) before preparing a public release.

The desktop workflow builds packages and uploads CI artifacts. Local packaging sets `publish: never`; the separate [release workflow](../.github/workflows/release.yml) verifies all platform packages, combines the two macOS update manifests, uploads a draft GitHub release, then publishes it only after every asset is present. See [releasing and automatic updates](releasing.md).

Publishing and checking for updates are separate. A locally built package that contains `app-update.yml` can still use the configured GitHub update feed. Use the isolated profiles in the [packaged shell checks](testing.md#packaged-application) when testing a local bundle.

Windows setup keeps its existing upgrade GUID and checks running copies by their installation path. It preserves application data and does not terminate unrelated app copies. The installer lifecycle checks are opt-in and require an unused installation plus the emulator fixture; inspect their test configuration before running them.

## Verification

Run unit/backend, renderer and desktop checks before packaging. Run the [packaged shell checks](testing.md) against the resulting executable. Native installation/upgrade/uninstall, signing/notarization and real-service behavior need separate validation on each supported platform.
