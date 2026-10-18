import { hydrateLibrary } from './hydrate'
import type { Hydrated, MetaNormalizer } from './hydrate'

/**
 * Reading the saved library at start-up, all or nothing. If any of the seven values cannot be read the window must not go on as
 * though the library were empty: the player writes its in-memory state back to the database, and an empty one would replace what
 * is stored. So a failed read is tried again (a transient error is common right after the browser starts), and when it still fails
 * the answer is a failure, which makes the window run without saving (see `gate.ts`).
 */

/** The two reads the library needs from the database: the tracks, and the values of `meta`. */
export interface LibraryReader {
  rows(): Promise<readonly unknown[]>
  meta(key: string): Promise<unknown>
}

export type LoadResult =
  | { ok: true; library: Hydrated }
  /** `unreadable`: the database failed to answer. `unavailable`: this browser keeps nothing for the page at all. */
  | { ok: false; reason: 'unreadable' | 'unavailable'; error: unknown }

export interface LoadOptions {
  /** How long to wait before each further try; the number of tries is one more than this. */
  delays?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}

const DELAYS: readonly number[] = [250, 800]
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the error means this browser lets the page keep nothing (no IndexedDB, or it is blocked), which no second try will change. */
export function isUnavailable(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'SecurityError'
  return error instanceof Error && error.message === 'IndexedDB unavailable'
}

/**
 * `meta` and `reader` are handed in by the player, not imported (see `MetaNormalizer` in `hydrate.ts`): the database code and the
 * track-metadata code are shared with start-up, and a lazy chunk that imports them makes the bundler cut shared files out of the
 * start-up chunk.
 */
export async function loadLibrary(meta: MetaNormalizer, reader: LibraryReader, { delays = DELAYS, sleep = wait }: LoadOptions = {}): Promise<LoadResult> {
  let failure: unknown
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await sleep(delays[attempt - 1] ?? 0)
    try {
      const [rows, order, playlists, resume, trackEq, pending, upNext] = await Promise.all([reader.rows(), reader.meta('order'), reader.meta('playlists'), reader.meta('resume'), reader.meta('trackEq'), reader.meta('pendingRestore'), reader.meta('upNext')])
      return { ok: true, library: hydrateLibrary({ rows, order, playlists, resume, trackEq, upNext, pending }, meta) }
    } catch (error) {
      failure = error
      if (isUnavailable(error)) return { ok: false, reason: 'unavailable', error }
    }
  }
  return { ok: false, reason: 'unreadable', error: failure }
}
