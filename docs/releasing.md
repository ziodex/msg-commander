# Releases and automatic updates

Public releases and the installed update feed use [ziodex/msg-commander](https://github.com/ziodex/msg-commander). The Azure DevOps remote does not run GitHub Actions. Push release commits and tags to the GitHub repository. Builds in forks must explicitly configure their own update provider before distributing an application.

## User experience

Installed releases check 15 seconds after startup and every six hours while running. New stable versions download in the background. A desktop notification announces the new version; a native dialog offers **Restart and install** or **Later** when the download is verified. A user who chooses Later can reopen it through **Preferences → Application updates → Check for updates** or **Help → Check for updates…**. Preferences provides access on systems where the native menu bar is hidden.

The app does not restart automatically or install on an ordinary quit. It blocks installation while tracked operations are running. Once the user accepts, it blocks new desktop requests, finishes queued workspace writes, closes messaging connections and stops the backend before invoking the installer. Offline/background failures stay quiet; a manual check reports failures and allows retry. A failed download or installer check leaves the saved workspace intact.

Only stable versions are offered; automatic downgrades and prereleases are disabled. Linux updates require running the AppImage. Development builds and explicit `--user-data-dir` profiles never contact the update service. Versions distributed before this feature require one manual upgrade to an update-enabled release.

## Signing secrets

Add the following **GitHub Actions repository secrets** in `ziodex/msg-commander` before publishing. Secret values must never be committed or embedded in the application.

| Secret                        | Value                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`                | Base64-encoded `.p12` containing an Apple **Developer ID Application** certificate and private key. |
| `MAC_CSC_KEY_PASSWORD`        | Password protecting that `.p12`.                                                                    |
| `APPLE_ID`                    | Apple developer account email used for notarization.                                                |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account.                                                             |
| `APPLE_TEAM_ID`               | Apple Developer team identifier.                                                                    |
| `WINDOWS_CSC_LINK`            | Base64-encoded code-signing `.p12`/`.pfx` certificate and private key.                              |
| `WINDOWS_CSC_KEY_PASSWORD`    | Password protecting that certificate.                                                               |

The workflow's `GITHUB_TOKEN` supplies release-upload access; users do not need a GitHub token. Release builds require code signing and macOS notarization. Ordinary CI/local packages remain development builds and are not public releases. macOS automatic updates require signed applications, as described in the [electron-builder update documentation](https://www.electron.build/v26/docs/features/auto-update/).

## Publish a release

1. Update `package.json` and the root version in `package-lock.json` together using `npm version <major.minor.patch> --no-git-tag-version`. Choose a version higher than any published version and commit it with the release changes.
2. Push the tested commit to the GitHub repository. Keep the existing Azure remote if it is still used for development.
3. Create and push the matching stable tag, for example `v0.64.0`. A tag must exactly match `package.json`; prerelease tags are rejected.
4. Watch **Publish GitHub release** in GitHub Actions. It builds and tests macOS ARM64, macOS Intel, Windows x64 and Linux x64. Missing signing secrets, failed tests, missing packages or invalid checksums prevent publication.
5. The publishing job uploads the installers, ZIP files, blockmaps and `latest*.yml` manifests to a draft, then makes the complete release public. The macOS manifest contains both architectures. Published releases cannot be overwritten by this workflow; fixes need a higher version.

No tag is created by normal development pushes. A failed publish leaves the release in draft, so users cannot discover an incomplete update. Rerunning the same workflow can replace draft assets. Release downloads include checksum verification; the updater also performs the platform's signature checks. Keep the application ID, Windows upgrade GUID and signing identity stable across versions.

## Saved connections and upgrade qualification

The app stores `workspace.json` outside the installed application. Normal upgrades retain connection metadata, preferences and encrypted remembered credentials. Existing installations reuse their current profile folder and credential-store identity, including installations from before the product rename. Session-only credentials intentionally expire on restart. Remembered credentials belong to the same OS user and secure storage; copying a workspace to another computer does not transfer access to its encryption key.

The Windows installer explicitly preserves application data. The update flow never deletes or replaces the workspace. Workspace tests verify version-1 migration, unchanged stored ciphertext and queued writes completed before shutdown. Application-identity tests verify discovery of the earlier profile.

Before the first public update, install two successively versioned, signed releases on each supported system. Save a remembered connection and preferences in the first, then update using the installed app. Confirm the version changes, preferences remain, and the saved credential can reconnect. Also test Later, offline checks, an invalid download and an active operation. Unit and packaged launch checks do not replace this signed installation test. Signing credentials are not yet configured, so a complete signed upgrade cannot currently be verified locally.
