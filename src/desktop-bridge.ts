/**
 * The contract between the web app and its desktop shell (Electron, in `desktop/`).
 *
 * The shell's preload script puts a `wavelocalDesktop` object on `window`; in a normal browser, the PWA and the
 * Android app it simply does not exist, so every desktop-only feature must go through `getDesktopBridge()` and
 * treat `null` as "not running on the desktop". The renderer owns this contract (the shell imports these types, the
 * web app never imports anything from `desktop/`).
 */

export interface DesktopBridge {
  readonly isDesktop: true
  /** Node's `process.platform`: 'win32', 'darwin', 'linux', ... */
  readonly platform: string
  readonly versions: {
    readonly app: string
    readonly electron: string
    readonly chrome: string
  }
}

declare global {
  interface Window {
    wavelocalDesktop?: DesktopBridge
  }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

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
  return { isDesktop: true, platform: b.platform, versions: { app: versions.app, electron: versions.electron, chrome: versions.chrome } }
}
