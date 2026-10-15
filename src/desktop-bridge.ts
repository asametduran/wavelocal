/**
 * The contract between the web app and its desktop shell (Electron, in `desktop/`).
 *
 * The shell's preload script puts a `wavelocalDesktop` object on `window`; in a normal browser, the PWA and the
 * Android app it simply does not exist, so every desktop-only feature must go through `getDesktopBridge()` and
 * treat `null` (or a missing capability) as "not running on the desktop". The renderer owns this contract (the shell
 * imports these types, the web app never imports anything from `desktop/`).
 */

/** What the tray menu or a global hotkey can ask the player to do. */
export type DesktopCommand = 'toggle' | 'next' | 'prev' | 'volumeUp' | 'volumeDown' | 'mute'

export const DESKTOP_COMMANDS: readonly DesktopCommand[] = ['toggle', 'next', 'prev', 'volumeUp', 'volumeDown', 'mute']

/** What the shell shows in the tray tooltip and menu. Titles are untrusted text: the shell clips and cleans them. */
export interface NowPlaying {
  readonly title: string
  readonly artist: string
  readonly playing: boolean
}

/** Present only when the shell has a system tray. */
export interface TrayBridge {
  /** Tell the tray what is playing; `null` means nothing is loaded. */
  setNowPlaying(state: NowPlaying | null): void
}

/** Commands chosen outside the page: in the tray menu or with a global hotkey. */
export interface CommandsBridge {
  /** Returns the unsubscribe function. */
  onCommand(listener: (command: DesktopCommand) => void): () => void
}

/** `active`: registered with the system. `disabled`: no accelerator. `taken`: another application owns it. */
export type HotkeyStatus = 'active' | 'disabled' | 'taken'

export interface HotkeyEntry {
  /** Electron accelerator syntax in its canonical form, e.g. `Ctrl+Alt+Right` or `MediaPlayPause`; null when disabled. */
  readonly accelerator: string | null
  readonly status: HotkeyStatus
}

export type HotkeyState = Readonly<Record<DesktopCommand, HotkeyEntry>>

export type HotkeyError = 'invalid' | 'reserved' | 'conflict' | 'taken'

export type HotkeyResult =
  | { readonly ok: true; readonly state: HotkeyState }
  | { readonly ok: false; readonly error: HotkeyError; readonly message: string; readonly state: HotkeyState }

/** Present only when the shell can register global hotkeys. */
export interface HotkeysBridge {
  /** The current bindings; also asks the system again for any that were taken. */
  get(): Promise<HotkeyState>
  /** Bind (or, with `null`, unbind) one command. A refused change leaves the previous binding in place. */
  set(command: DesktopCommand, accelerator: string | null): Promise<HotkeyResult>
  /** Restore the default bindings (the media keys). */
  reset(): Promise<HotkeyState>
}

export interface DesktopBridge {
  readonly isDesktop: true
  /** Node's `process.platform`: 'win32', 'darwin', 'linux', ... */
  readonly platform: string
  readonly versions: {
    readonly app: string
    readonly electron: string
    readonly chrome: string
  }
  readonly tray?: TrayBridge
  readonly commands?: CommandsBridge
  readonly hotkeys?: HotkeysBridge
}

declare global {
  interface Window {
    wavelocalDesktop?: DesktopBridge
  }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The named functions of a capability object (rebound to the original), or null unless every one is present. */
function functionsOf<T>(raw: unknown, names: readonly string[]): T | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const name of names) {
    const fn = source[name]
    if (typeof fn !== 'function') return null
    out[name] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(source, args)
  }
  return out as T
}

/**
 * The desktop bridge, or null when the app is not running inside the desktop shell. The object is validated and
 * copied, so a page script that merely defines `window.wavelocalDesktop` cannot make the app believe in capabilities
 * that were not granted.
 */
export function getDesktopBridge(target: { wavelocalDesktop?: unknown } | undefined = globalThis as { wavelocalDesktop?: unknown }): DesktopBridge | null {
  const raw = target?.wavelocalDesktop
  if (typeof raw !== 'object' || raw === null) return null
  const b = raw as Record<string, unknown>
  const v = b.versions
  if (b.isDesktop !== true || !isText(b.platform) || typeof v !== 'object' || v === null) return null
  const versions = v as Record<string, unknown>
  if (!isText(versions.app) || !isText(versions.electron) || !isText(versions.chrome)) return null

  const tray = functionsOf<TrayBridge>(b.tray, ['setNowPlaying'])
  const commands = functionsOf<CommandsBridge>(b.commands, ['onCommand'])
  const hotkeys = functionsOf<HotkeysBridge>(b.hotkeys, ['get', 'set', 'reset'])
  return {
    isDesktop: true,
    platform: b.platform,
    versions: { app: versions.app, electron: versions.electron, chrome: versions.chrome },
    ...(tray && { tray }),
    ...(commands && { commands }),
    ...(hotkeys && { hotkeys }),
  }
}
