/**
 * The seek bar style, "waveform" or "plain", kept on this device. It is a small store (not component state) because the seek
 * bar is mounted twice and the settings panel changes it: all of them must follow one switch. The start-up code reads the same
 * key directly (`PlayerBar.tsx`) only to reserve the space before this module has loaded.
 */

export type SeekStyle = 'waveform' | 'plain'
export const SEEK_STYLE_KEY = 'wl.seekbar'

/** The waveform unless the person chose the plain bar: an unknown or damaged value must never hide it. */
export const parseSeekStyle = (raw: unknown): SeekStyle => (raw === 'plain' ? 'plain' : 'waveform')

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function createSeekStylePref(storage: () => StorageLike | null) {
  let current: SeekStyle | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const read = (): SeekStyle => {
    try {
      return parseSeekStyle(storage()?.getItem(SEEK_STYLE_KEY))
    } catch {
      return 'waveform' // storage blocked: the default for this visit
    }
  }
  const get = (): SeekStyle => (current ??= read())
  // plain functions, not methods, so they can be handed to React or to an event listener without losing what they belong to
  const set = (next: SeekStyle): void => {
    if (get() === next) return
    current = next
    try {
      storage()?.setItem(SEEK_STYLE_KEY, next)
    } catch {
      // storage blocked: the choice lasts for this visit
    }
    emit()
  }
  /** Read the stored choice again (another window changed it) and tell the listeners if it differs. */
  const refresh = (): void => {
    const before = current
    current = read()
    if (current !== before && before !== null) emit()
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { get, set, refresh, subscribe }
}

function deviceStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // some browsers throw when storage is blocked
  }
}

export const seekStyle = createSeekStylePref(deviceStorage)

// a change made in another window of the app
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => event.key === SEEK_STYLE_KEY && seekStyle.refresh())
