import type { KeyValue } from '../rawdb'
import { normalizeBookmarks } from './bookmarks'
import type { Bookmark, ListenRecord } from './types'

/**
 * What a person keeps about one recording, in the app's `meta` store under `listen:<track key>`. The key is the library key of
 * the file (`name|size|modified`, the one the importer uses to skip duplicates), not the id the library gave it, so the
 * bookmarks outlive removing the file and adding it again, and a backup can carry them to another device. Unlike the derived
 * caches (waveforms, chapters) this is the person's own data: a failed read is not a miss that gets overwritten, and a record
 * with nothing to remember is not kept at all.
 */

export const LISTEN_PREFIX = 'listen:'

export const listenKey = (trackKey: string): string => LISTEN_PREFIX + trackKey

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The bookmarks of a stored value. Anything that is not exactly a record of this version reads as none (the next change writes
 * a proper one), and what is in a record is untrusted like any file: it goes through the same rules as a list a person makes.
 */
export function readListenRecord(value: unknown, newId: () => string): Bookmark[] {
  if (!isRecord(value) || value.v !== 1) return []
  return normalizeBookmarks(value.bookmarks, { newId })
}

/** The bookmarks kept for a track: a list (empty for a track with none), or null when the database could not be read. */
export async function loadBookmarks(kv: KeyValue, trackKey: string, newId: () => string): Promise<Bookmark[] | null> {
  try {
    return readListenRecord(await kv.get(listenKey(trackKey)), newId)
  } catch {
    return null
  }
}

/** Keep the list as the track's record (an empty list deletes it). False when the disk is full or blocked; it never throws. */
export async function saveBookmarks(kv: KeyValue, trackKey: string, bookmarks: readonly Bookmark[], now: number): Promise<boolean> {
  try {
    if (bookmarks.length === 0) await kv.delete(listenKey(trackKey))
    else await kv.set(listenKey(trackKey), { v: 1, at: now, bookmarks: [...bookmarks] } satisfies ListenRecord)
    return true
  } catch {
    return false
  }
}
