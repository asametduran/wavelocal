/**
 * A setting with a few named values, kept on this device. It is a small store (not component state) because the thing it
 * changes is drawn in several places and changed from a settings panel: all of them must follow one switch. `parse` turns
 * whatever is stored into one of the values, and must give the default for anything else: an unknown or damaged value must
 * never hide a feature.
 */

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ChoicePref<T extends string> {
  get: () => T
  set: (next: T) => void
  /** Read the stored choice again (another window changed it) and tell the listeners if it differs. */
  refresh: () => void
  subscribe: (listener: () => void) => () => void
}

// plain functions, not methods, so they can be handed to React or to an event listener without losing what they belong to
export function createChoicePref<T extends string>(key: string, parse: (raw: unknown) => T, storage: () => StorageLike | null): ChoicePref<T> {
  let current: T | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const read = (): T => {
    try {
      return parse(storage()?.getItem(key))
    } catch {
      return parse(undefined) // storage blocked: the default for this visit
    }
  }
  const get = (): T => (current ??= read())
  const set = (next: T): void => {
    if (get() === next) return
    current = next
    try {
      storage()?.setItem(key, next)
    } catch {
      // storage blocked: the choice lasts for this visit
    }
    emit()
  }
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

/** The device's local storage, or null where there is none or where merely touching it throws (some browsers do when it is blocked). */
export function deviceStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Ask for a fresh read of a setting when another window of the app changes its key. */
export function followOtherWindows(key: string, refresh: () => void): void {
  if (typeof window !== 'undefined') window.addEventListener('storage', (event) => event.key === key && refresh())
}
