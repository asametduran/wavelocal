import { contextBridge, ipcRenderer } from 'electron'
// the web app's package is an ES module while this (sandboxed) preload must be CommonJS: say which flavour of types we mean
import type { DesktopBridge, DesktopCommand, HotkeyResult, HotkeyState, NowPlaying } from '../../src/desktop-bridge.js' with { 'resolution-mode': 'import' }
import type { CHANNEL } from './ipc'

/**
 * Runs in the sandboxed preload context before the page. It exposes one small, frozen object so the web app can tell
 * it is running inside the desktop shell and talk to it. A sandboxed preload can only load Electron's own modules, so
 * this file is self-contained: the channel names are repeated and the compiler checks them against ./ipc.
 * Nothing from Node or Electron itself is ever handed to the page; messages from the page are validated by the main
 * process, and commands going the other way are filtered here to the known set.
 */

const NOW_PLAYING: typeof CHANNEL.nowPlaying = 'wavelocal:now-playing'
const COMMAND: typeof CHANNEL.command = 'wavelocal:command'
const HOTKEYS_GET: typeof CHANNEL.hotkeysGet = 'wavelocal:hotkeys-get'
const HOTKEYS_SET: typeof CHANNEL.hotkeysSet = 'wavelocal:hotkeys-set'
const HOTKEYS_RESET: typeof CHANNEL.hotkeysReset = 'wavelocal:hotkeys-reset'
const COMMANDS: readonly DesktopCommand[] = ['toggle', 'next', 'prev', 'volumeUp', 'volumeDown', 'mute']

const argument = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const bridge: DesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  versions: Object.freeze({
    app: argument('wl-app-version') || '0.0.0',
    electron: process.versions.electron || 'unknown',
    chrome: process.versions.chrome || 'unknown',
  }),
  tray: Object.freeze({
    setNowPlaying(state: NowPlaying | null): void {
      // send a plain copy, never the page's own object
      ipcRenderer.send(NOW_PLAYING, state ? { title: String(state.title), artist: String(state.artist), playing: state.playing === true } : null)
    },
  }),
  commands: Object.freeze({
    onCommand(listener: (command: DesktopCommand) => void): () => void {
      const handler = (_event: unknown, command: unknown) => {
        const known = COMMANDS.find((c) => c === command)
        if (known) listener(known)
      }
      ipcRenderer.on(COMMAND, handler)
      return () => void ipcRenderer.removeListener(COMMAND, handler)
    },
  }),
  hotkeys: Object.freeze({
    get: (): Promise<HotkeyState> => ipcRenderer.invoke(HOTKEYS_GET) as Promise<HotkeyState>,
    set: (command: DesktopCommand, accelerator: string | null): Promise<HotkeyResult> =>
      ipcRenderer.invoke(HOTKEYS_SET, String(command), accelerator === null ? null : String(accelerator)) as Promise<HotkeyResult>,
    reset: (): Promise<HotkeyState> => ipcRenderer.invoke(HOTKEYS_RESET) as Promise<HotkeyState>,
  }),
})

contextBridge.exposeInMainWorld('wavelocalDesktop', bridge)
