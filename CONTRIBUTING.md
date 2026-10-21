# Contributing

Start with the [development guide](docs/development.md) and [architecture](docs/architecture.md). Use an issue to discuss changes that affect public behavior, supported services or file formats.

## Local checks

```sh
npm ci
npm test
npm run build
npm run test:desktop
```

Keep changes focused and describe the behavior they change. Include the checks you ran and identify anything that requires a native platform, Docker or live Azure resources. The [testing guide](docs/testing.md) explains those boundaries.

Run `npm run format` before submitting a change. Prettier formats the frontend, scripts and documentation; the .NET formatter formats backend and TestHost C# code. `npm run format:check` verifies both in CI. Code indentation uses tabs with a display width of four. YAML and generated dependency lock files retain their required or tool-owned space indentation.

Use a brief single-line comment when a non-obvious constraint or decision needs explanation. Describe the reason instead of repeating the code. Keep existing license notices intact. Preserve dependency lock files; use locked restoration when validating a package.

## Code boundaries

Keep provider SDK calls in backend Infrastructure, workflows in Application and business rules in Domain. Contracts contain data. The renderer calls the typed desktop API through feature entry points; filesystem access and credentials stay in the main process or backend.

Preserve exact sequence numbers, opaque binary bodies and explicit operation outcomes. Tests for writes should distinguish rejection, confirmation and lost acknowledgement. Never automatically repeat an uncertain write.

## Reporting problems

Provide the app version, operating system, steps to reproduce and the observed result. Use synthetic resource names and payloads; remove credentials and personal data from diagnostics. Report suspected credential exposure privately through the repository's **Security → Report a vulnerability** feature when available; keep sensitive details out of public issues.

## License

Contributions are provided under the project's [MIT license](LICENSE). Retain applicable third-party notices when adding dependencies or copied components.
