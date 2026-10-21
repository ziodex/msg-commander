# Msg Commander identity

The product name is **Msg Commander**; code and .NET assemblies use `MsgCommander`, and package and executable names use `msg-commander`.

The canonical icon is `src/renderer/src/assets/msg-commander-icon.png`, a 1024 × 1024 PNG with transparent outer corners. `npm run icons` copies it to `build/icon.png`; electron-builder derives platform icons. The same artwork appears in the sidebar, application window and macOS Dock.

## Upgrade compatibility

The app prefers `workspace.json` in the Msg Commander application-data folder. If that file is absent and the previous Service Bus Commander folder contains a workspace, it reuses the previous folder and encryption identity. Electron captures the encryption identity before ready; the visible application name becomes Msg Commander at ready. Fresh installations use the new folder and identity. Explicit `--user-data-dir` overrides bypass automatic discovery and disable update checks. Startup does not decrypt credentials or open the keychain.

New exports use `msg-commander/…` format identifiers and `.msgc.json` suggested filenames. Readers also accept the previous `service-bus-commander/…` identifiers and normalize the format after validation. Body bytes, typed values, limits and duplicate-field checks remain intact. Previously exported `.sbc.json` files remain readable.

The Windows installer retains its original upgrade GUID and detects running executables under both names. Old product identifiers remain only where needed to read native exports and retain existing workspace credentials. Retired implementation and qualification records are available in Git history.

## Icon provenance

Created with the built-in image-generation tool, then scaled to 1024 × 1024 with alpha preserved. The final generation prompt was:

```text
Use case: logo-brand
Asset type: production desktop application icon for Msg Commander, a professional developer tool for inspecting, routing and testing messages across cloud messaging services.
Primary request: Design one distinctive polished app icon, immediately legible at 16–32 pixels. A single bold geometric ivory message/envelope mark subtly forming an angular M through its folds, with one restrained orange routing accent that conveys messages moving through a system. Warm charcoal rounded-square tile, ivory foreground, restrained burnt-orange/copper accent matching a warm editorial desktop interface. Minimal, confident and technical, optically balanced with large negative spaces and consistent thick geometry. Flat vector-like precision, crisp edges, no illustration details. Square 1024 pixel canvas; centered rounded square occupies 88–90 percent of the canvas, with genuinely transparent pixels outside the tile and rounded corners. Keep the mark visually large inside the tile. Subtle material depth is acceptable only if invisible at small sizes.
Constraints: one icon only, front-on view; no words, no labels, no letters rendered as text, no watermark, no border, no perspective, no mockup scene, no glow, no tiny nodes, no glossy 3D rendering, no Azure or Microsoft symbols. This is a new original identity, not an edit of an existing logo.
```
