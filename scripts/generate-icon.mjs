import { copyFileSync } from 'node:fs'

// The PNG is the source artwork. electron-builder derives the native ICO/ICNS assets.
copyFileSync('src/renderer/src/assets/msg-commander-icon.png', 'build/icon.png')
