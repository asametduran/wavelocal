import { contextBridge } from 'electron'
// the web app's package is an ES module while this (sandboxed) preload must be CommonJS: say which flavour of types we mean
import type { DesktopBridge } from '../../src/desktop-bridge.js' with { 'resolution-mode': 'import' }

/**
 * Runs in the sandboxed preload context before the page. It exposes one small, frozen, read-only object so the web
 * app can tell it is running inside the desktop shell. (Later milestones add typed IPC calls here; nothing from
 * Node or Electron is ever handed to the page itself.)
 */

const argument = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const bridge: DesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  versions: Object.freeze({
    app: argument('wl-app-version') || '0.0.0',
    electron: process.versions.electron || 'unknown',
    chrome: process.versions.chrome || 'unknown',
  }),
})

contextBridge.exposeInMainWorld('wavelocalDesktop', bridge)
