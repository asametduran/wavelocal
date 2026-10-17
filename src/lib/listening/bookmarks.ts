import { cleanLine } from '../chapters/normalize'
import type { Bookmark } from './types'

/**
 * The bookmarks of one recording as plain data in and out: the service, the dialogs and the backup all go through these
 * functions, so every list that is shown, stored or restored obeys the same rules. A list is ordered by time, holds at most
 * `MAX_BOOKMARKS`, has no two bookmarks closer than `SAME_PLACE`, and no two with the same id. Nothing here changes a list in
 * place; each answer is a new one. What comes from storage or from a backup file is untrusted and goes through
 * `normalizeBookmarks`.
 */

export const MAX_BOOKMARKS = 200
export const MAX_LABEL = 80
/** Two bookmarks less than this many seconds apart are one place. */
export const SAME_PLACE = 0.5
const MAX_ID = 64

/** A name fit to show on one line, or '' when nothing is left of it. */
export const cleanLabel = (value: unknown): string => cleanLine(value, MAX_LABEL)

/** "Bookmark 3": the first number that no bookmark in `list` carries in its name yet, so a deleted one is not skipped for good. */
function defaultLabel(list: readonly Bookmark[]): string {
  const taken = new Set(list.map((b) => b.label))
  let n = 1
  while (taken.has(`Bookmark ${n}`)) n++
  return `Bookmark ${n}`
}

/** The bookmark of `list` nearest to `t`, if it is closer than `SAME_PLACE`. */
function bookmarkNear(list: readonly Bookmark[], t: number): Bookmark | undefined {
  let nearest: Bookmark | undefined
  for (const b of list) if (Math.abs(b.t - t) < SAME_PLACE && (!nearest || Math.abs(b.t - t) < Math.abs(nearest.t - t))) nearest = b
  return nearest
}

/** `list` with `bookmark` put in its place in time (after any at the very same time). */
function withBookmark(list: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
  const at = list.findIndex((b) => b.t > bookmark.t)
  return at < 0 ? [...list, bookmark] : [...list.slice(0, at), bookmark, ...list.slice(at)]
}

export interface NewBookmark {
  /** Seconds; 0 when the length of the file is not known. */
  duration: number
  /** Milliseconds since the epoch. */
  now: number
  id: string
  /** The person's name for it. Without one, or with one that is nothing once cleaned, it is called "Bookmark N". */
  label?: string
}

export type AddResult =
  | { ok: true; list: Bookmark[]; bookmark: Bookmark }
  /** `bad`: not a place in the file. `full`: the track holds as many as it can. */
  | { ok: false; reason: 'bad' | 'full' }
  /** Another bookmark is less than `SAME_PLACE` away: this one. */
  | { ok: false; reason: 'there'; existing: Bookmark }

/** Add a bookmark at `t` seconds. */
export function addBookmark(list: readonly Bookmark[], t: number, options: NewBookmark): AddResult {
  const known = Number.isFinite(options.duration) && options.duration > 0
  if (!Number.isFinite(t) || t < 0 || (known && t > options.duration)) return { ok: false, reason: 'bad' }
  const existing = bookmarkNear(list, t)
  if (existing) return { ok: false, reason: 'there', existing }
  if (list.length >= MAX_BOOKMARKS) return { ok: false, reason: 'full' }
  const bookmark: Bookmark = { id: options.id, t, label: cleanLabel(options.label) || defaultLabel(list), at: options.now }
  return { ok: true, list: withBookmark(list, bookmark), bookmark }
}

/** Take a bookmark out, and hand it back so that it can be put back. Null when there is no such bookmark. */
export function removeBookmark(list: readonly Bookmark[], id: string): { list: Bookmark[]; removed: Bookmark } | null {
  const removed = list.find((b) => b.id === id)
  return removed ? { list: list.filter((b) => b !== removed), removed } : null
}

/**
 * Put a bookmark that was taken out back (the Undo of a delete). The list stays as it was when that cannot be done: the id is
 * already there, the track is full, or another bookmark was made at that place since.
 */
export function insertBookmark(list: readonly Bookmark[], bookmark: Bookmark): Bookmark[] {
  if (list.length >= MAX_BOOKMARKS || list.some((b) => b.id === bookmark.id) || bookmarkNear(list, bookmark.t)) return [...list]
  return withBookmark(list, bookmark)
}

/** Give a bookmark a new name. Null when there is no such bookmark, or the name is nothing once cleaned (the old one stays). */
export function renameBookmark(list: readonly Bookmark[], id: string, label: unknown): Bookmark[] | null {
  const clean = cleanLabel(label)
  if (!clean || !list.some((b) => b.id === id)) return null
  return list.map((b) => (b.id === id ? { ...b, label: clean } : b))
}

/** A bookmark as a backup file holds it: a place and a name (the id and the date belong to the device that makes it). */
export interface IncomingBookmark {
  t: number
  label: string
}

/**
 * Bring the bookmarks of a backup into a track's own. What is there stays exactly as it is (a name the person chose here is not
 * replaced), and each incoming bookmark is added unless there is one at its place already or the track is full. Merging the same
 * backup again adds nothing. `added` is how many were new.
 */
export function mergeBookmarks(local: readonly Bookmark[], incoming: readonly IncomingBookmark[], options: { now: number; newId: () => string }): { list: Bookmark[]; added: number } {
  let list: readonly Bookmark[] = local
  let added = 0
  for (const entry of [...incoming].sort((a, b) => a.t - b.t)) {
    const result = addBookmark(list, entry.t, { duration: 0, now: options.now, id: options.newId(), label: entry.label })
    if (result.ok) {
      list = result.list
      added++
    } else if (result.reason === 'full') break
  }
  return { list: [...list], added }
}

export interface NormalizeOptions {
  /** Seconds; 0 (or nothing) when the length of the file is not known. */
  duration?: number
  /** A fresh id, for an entry that came without a usable one (a backup file holds only the time and the name). */
  newId: () => string
}

/**
 * The bookmarks of anything read back: a stored record, a backup file. Each entry is copied field by field (nothing else comes
 * along), and one that is not a place in the file is dropped, as is the second of two with the same id or the same place. A
 * missing name becomes "Bookmark N", a missing id a new one, a missing or damaged date 0. At most `MAX_BOOKMARKS` are kept,
 * the earliest in the file.
 */
export function normalizeBookmarks(raw: unknown, { duration = 0, newId }: NormalizeOptions): Bookmark[] {
  if (!Array.isArray(raw)) return []
  const known = Number.isFinite(duration) && duration > 0
  const entries: { t: number; label: string; id: string; at: number }[] = []
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { t, label, id, at } = entry as Record<string, unknown>
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || (known && t > duration)) continue
    entries.push({
      t,
      label: cleanLabel(label),
      id: typeof id === 'string' ? id.slice(0, MAX_ID) : '',
      at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0,
    })
  }
  entries.sort((a, b) => a.t - b.t)

  const list: Bookmark[] = []
  const ids = new Set<string>()
  for (const entry of entries) {
    if (list.length >= MAX_BOOKMARKS) break
    const last = list.at(-1)
    if (last && entry.t - last.t < SAME_PLACE) continue
    if (entry.id && ids.has(entry.id)) continue
    let id = entry.id || newId()
    if (ids.has(id)) id = `${id.slice(0, MAX_ID - 8)}~${list.length}` // a generator that repeats itself must not make two bookmarks one
    ids.add(id)
    list.push({ id, t: entry.t, label: entry.label || defaultLabel(list), at: entry.at })
  }
  return list
}
