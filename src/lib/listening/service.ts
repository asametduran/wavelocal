import type { KeyValue } from '../rawdb'
import { addBookmark, insertBookmark, mergeBookmarks, removeBookmark, renameBookmark } from './bookmarks'
import type { AddResult, IncomingBookmark } from './bookmarks'
import { LISTEN_PREFIX, loadBookmarks, saveBookmarks } from './store'
import type { Bookmark } from './types'

/**
 * Whose bookmarks are on screen and what happens when they change. The seek bar is mounted twice (footer and phone sheet) and
 * the list dialog and the keys read the same data, so there is one shared store, keyed by the track's library key. A change
 * shows at once and is kept afterwards. Everything that touches the database (reading a track's record, keeping a change,
 * merging a backup, collecting for one) runs one thing after the other in the order it was asked for, so that a read always
 * sees what was written before it, and a slow write answering late cannot put an older list over a newer one. A change that
 * cannot be kept stays on screen for this visit and is kept with the next one that can: every write holds the whole list.
 */

export type BookmarksState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; bookmarks: readonly Bookmark[] } | { status: 'error' }

export interface ListeningTarget {
  /** The library key of the track (`name|size|modified`). */
  key: string
}

export interface ListeningDeps {
  kv: KeyValue
  /** Milliseconds since the epoch. */
  now: () => number
  newId: () => string
  /** A change could not be kept (the disk is full or blocked). Called once for each failed write. */
  onSaveError?: () => void
  /** How many tracks' lists are kept in memory (an older one comes back from the database). */
  keep?: number
}

export type AddOutcome = AddResult | { ok: false; reason: 'unavailable' }

/** The bookmarks a backup holds for one track. */
export interface MergeEntry {
  key: string
  bookmarks: readonly IncomingBookmark[]
}

export interface MergeOutcome {
  /** Bookmarks that were new. */
  added: number
  /** Tracks whose record could not be read: they were left as they are. */
  unreadable: number
}

const IDLE: BookmarksState = { status: 'idle' }
const LOADING: BookmarksState = { status: 'loading' }
const FAILED: BookmarksState = { status: 'error' }

/** The bookmarks of a state: the list when it is ready, otherwise none (the same empty list each time). */
const NONE: readonly Bookmark[] = Object.freeze([])
export const bookmarksOf = (state: BookmarksState): readonly Bookmark[] => (state.status === 'ready' ? state.bookmarks : NONE)

export class ListeningService {
  private readonly states = new Map<string, BookmarksState>()
  private readonly listeners = new Set<() => void>()
  /** The last of the database operations still to come. It never rejects: `enqueue` hands the result to the caller. */
  private ops: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ListeningDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The same object until the track's state changes, as `useSyncExternalStore` requires. */
  getState = (key: string): BookmarksState => this.states.get(key) ?? IDLE

  /** Make sure the bookmarks of the current track are on their way (or here); `null` when nothing is playing. A failed read is tried again. */
  want(target: ListeningTarget | null): void {
    if (!target) return
    const { key } = target
    const known = this.states.get(key)
    if (known && known !== FAILED) {
      if (known !== LOADING) this.set(key, known) // seen lately: keep it in memory
      return
    }
    this.set(key, LOADING)
    void this.enqueue(async () => {
      const bookmarks = await loadBookmarks(this.deps.kv, key, this.deps.newId)
      this.set(key, bookmarks ? { status: 'ready', bookmarks } : FAILED)
    })
  }

  /**
   * Add a bookmark at `t` seconds of a file `duration` seconds long (0 when that is not known), named `label` or by number.
   * Refused (nothing changes) while the track's bookmarks are not known: a list that is still being read must not be written over.
   */
  add(key: string, t: number, duration: number, label?: string): AddOutcome {
    const list = this.ready(key)
    if (!list) return { ok: false, reason: 'unavailable' }
    const result = addBookmark(list, t, { duration, now: this.deps.now(), id: this.deps.newId(), label })
    if (result.ok) this.change(key, result.list)
    return result
  }

  /** Take a bookmark out and hand it back (so that the caller can offer to restore it). Null when there is no such bookmark. */
  remove(key: string, id: string): Bookmark | null {
    const list = this.ready(key)
    const result = list ? removeBookmark(list, id) : null
    if (!result) return null
    this.change(key, result.list)
    return result.removed
  }

  /** Put a removed bookmark back where it was. False when that cannot be done (another one was made at that place meanwhile). */
  restore(key: string, bookmark: Bookmark): boolean {
    const list = this.ready(key)
    if (!list) return false
    const next = insertBookmark(list, bookmark)
    if (next.length === list.length) return false
    this.change(key, next)
    return true
  }

  /** Give a bookmark a new name. False when there is no such bookmark or the name is nothing once cleaned. */
  rename(key: string, id: string, label: string): boolean {
    const list = this.ready(key)
    const next = list ? renameBookmark(list, id, label) : null
    if (!next) return false
    this.change(key, next)
    return true
  }

  /**
   * The bookmarks kept for these tracks (library keys), for a backup: only the tracks that have some. It comes after every change
   * made so far, and takes the list on screen where there is one. It fails if a record cannot be read, so a backup is never
   * handed over with bookmarks quietly missing.
   */
  collect(keys: readonly string[]): Promise<Record<string, Bookmark[]>> {
    return this.enqueue(async () => {
      const wanted = new Set(keys)
      const found: Record<string, Bookmark[]> = {}
      for (const key of keys) {
        const shown = this.ready(key)
        if (shown?.length) found[key] = [...shown]
      }
      for (const stored of await this.deps.kv.keys(LISTEN_PREFIX)) {
        const key = stored.slice(LISTEN_PREFIX.length)
        if (!wanted.has(key) || this.ready(key)) continue
        const list = await loadBookmarks(this.deps.kv, key, this.deps.newId)
        if (!list) throw new Error('The bookmarks could not be read.')
        if (list.length) found[key] = list
      }
      return found
    })
  }

  /**
   * Bring the bookmarks of a backup into the tracks' own. The track on screen is changed on screen as well, so that the next
   * change made there does not write an older list over what was restored; the others are read, merged and kept without
   * disturbing what is in memory. A track whose record cannot be read is left as it is and counted.
   */
  merge(entries: readonly MergeEntry[]): Promise<MergeOutcome> {
    const outcome: MergeOutcome = { added: 0, unreadable: 0 }
    const { kv, now, newId } = this.deps
    const done = entries.map((entry) =>
      this.enqueue(async () => {
        if (entry.bookmarks.length === 0) return
        const shown = this.ready(entry.key)
        const current = shown ?? (await loadBookmarks(kv, entry.key, newId))
        if (!current) {
          outcome.unreadable++
          return
        }
        const { list, added } = mergeBookmarks(current, entry.bookmarks, { now: now(), newId })
        if (added === 0) return
        outcome.added += added
        if (shown) this.set(entry.key, { status: 'ready', bookmarks: list })
        await this.keep(entry.key, list)
      }),
    )
    return Promise.all(done).then(() => outcome)
  }

  private ready(key: string): readonly Bookmark[] | null {
    const state = this.states.get(key)
    return state?.status === 'ready' ? state.bookmarks : null
  }

  /** Run `run` after everything asked for before it. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.ops.then(run)
    this.ops = result.catch(() => undefined)
    return result
  }

  /** Show a new list at once and queue it to be kept. */
  private change(key: string, bookmarks: readonly Bookmark[]): void {
    this.set(key, { status: 'ready', bookmarks })
    void this.enqueue(() => this.keep(key, bookmarks))
  }

  private async keep(key: string, bookmarks: readonly Bookmark[]): Promise<void> {
    if (!(await saveBookmarks(this.deps.kv, key, bookmarks, this.deps.now()))) this.deps.onSaveError?.()
  }

  private set(key: string, state: BookmarksState): void {
    this.states.delete(key)
    this.states.set(key, state)
    const keep = this.deps.keep ?? 8
    for (const old of this.states.keys()) {
      if (this.states.size <= keep) break
      if (old !== key && this.states.get(old) !== LOADING) this.states.delete(old)
    }
    for (const listener of [...this.listeners]) listener()
  }
}
