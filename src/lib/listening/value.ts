/**
 * One value that several parts of the page read and any of them may change (the two seek bars, the key handler): a store for
 * `useSyncExternalStore`. Its functions are plain properties, not methods, so they can be handed to React or to an event listener
 * without losing what they belong to.
 */
export class Value<T> {
  private current: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.current = initial
  }

  get = (): T => this.current

  /** Change the value and tell the listeners, unless it is the same value. */
  set = (next: T): void => {
    if (Object.is(next, this.current)) return
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
