/** What a person keeps about one recording of their own: bookmarks now, where they stopped and at what speed later. Type-only. */

/** A named place in a recording. */
export interface Bookmark {
  id: string
  /** Seconds from the start of the file. */
  t: number
  label: string
  /** When it was made, in milliseconds since the epoch. */
  at: number
}

/** Bookmarks by the library key of their track (`name|size|modified`), as the backup takes them. */
export type BookmarksByKey = Readonly<Record<string, readonly Bookmark[]>>

/** What is kept for a track, under `listen:<track key>` in the app's `meta` store. A record with nothing to remember is not kept at all. */
export interface ListenRecord {
  v: 1
  /** When it was last changed (ms since the epoch), so the oldest can be forgotten first. */
  at: number
  bookmarks: Bookmark[]
}
