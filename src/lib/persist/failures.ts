/**
 * Trying a failed save again. A write that fails is not given up on: the library would otherwise stay on the screen and be lost with
 * the window. The wait grows with each failure in a row (a second, then two, four... up to half a minute) so a disk that stays full is
 * asked only now and then, and the person can say *Try again* to ask at once. Only the latest try of each write is kept: the player
 * hands over the newest value of a key every time it changes, and an old one must never be written over a newer one. A lazy chunk:
 * it is only fetched after a save has failed.
 */

export interface Timers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The waits before the first, second... try again, in milliseconds. The last one repeats. */
export const DELAYS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000]

interface Waiting {
  run: () => void
  handle: unknown
  /** Failures in a row so far, which says how long to wait next. */
  failures: number
}

export class Retrier {
  private readonly waiting = new Map<string, Waiting>()

  constructor(private readonly timers: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }) {}

  /** The write for `key` failed: run `run` again after the wait for this many failures in a row. A newer `run` replaces one that is waiting. */
  later(key: string, run: () => void): void {
    const before = this.waiting.get(key)
    if (before) this.timers.clear(before.handle)
    const failures = (before?.failures ?? 0) + 1
    const wait = DELAYS[Math.min(failures, DELAYS.length) - 1] ?? 30_000
    const entry: Waiting = { run, failures, handle: null }
    entry.handle = this.timers.set(() => {
      entry.handle = null
      run()
    }, wait)
    this.waiting.set(key, entry)
  }

  /** The write for `key` went through: forget it, and whatever was waiting for it. */
  done(key: string): void {
    const entry = this.waiting.get(key)
    if (!entry) return
    if (entry.handle !== null) this.timers.clear(entry.handle)
    this.waiting.delete(key)
  }

  /** Try every waiting write now. */
  now(): void {
    for (const entry of [...this.waiting.values()]) {
      if (entry.handle === null) continue // already running
      this.timers.clear(entry.handle)
      entry.handle = null
      entry.run()
    }
  }
}

const retrier = new Retrier()

export const retryLater = (key: string, run: () => void): void => retrier.later(key, run)
export const retryDone = (key: string): void => retrier.done(key)
export const retryNow = (): void => retrier.now()
