/**
 * How the library panel can show the current list, and the trail of album and artist pages opened from it. Pure, so the
 * rules (what a stored value may be, how Back moves through the pages) are tested without a browser.
 */

/** The lenses on a list: its tracks, grouped as albums, grouped as artists, or laid out as the folders it came from. */
export type BrowseMode = 'list' | 'albums' | 'artists' | 'folders'

export interface ModeInfo {
  mode: BrowseMode
  /** The tab's name. */
  label: string
  /** What the mode lists, singular, for the search box and its announcements. */
  noun: string
}

export const BROWSE_MODES: readonly ModeInfo[] = [
  { mode: 'list', label: 'Tracks', noun: 'track' },
  { mode: 'albums', label: 'Albums', noun: 'album' },
  { mode: 'artists', label: 'Artists', noun: 'artist' },
  { mode: 'folders', label: 'Folders', noun: 'track' },
]

const ALL: readonly BrowseMode[] = BROWSE_MODES.map((m) => m.mode)

/** A stored mode, repaired: anything unknown, or not offered where it is read, is the track list. */
export function parseMode(raw: unknown, allowed: readonly BrowseMode[] = ALL): BrowseMode {
  const found = BROWSE_MODES.find((m) => m.mode === raw)
  return found && allowed.includes(found.mode) ? found.mode : 'list'
}

/** The pages open one from another (album, its artist, another album), newest last. Refs look like `album:…`/`artist:…`. */
export type Trail = readonly string[]

/** Deeper than this the oldest page is forgotten: nobody goes back twelve pages. */
export const MAX_TRAIL = 8

const isPage = (ref: string): boolean => /^(album|artist):.+/.test(ref)

/**
 * The trail after opening `ref`. Opening the page that is already open changes nothing, and opening one the trail has
 * already passed returns to it instead of growing in a circle (album, its artist, the same album).
 */
export function openPage(trail: Trail, ref: string): Trail {
  if (!isPage(ref) || trail.at(-1) === ref) return trail
  const seen = trail.indexOf(ref)
  if (seen >= 0) return trail.slice(0, seen + 1)
  return [...trail, ref].slice(-MAX_TRAIL)
}

/** A trail read from somewhere it was stored (a history entry): only album and artist refs survive, and only the newest few. */
export function parseTrail(raw: unknown): Trail {
  if (!Array.isArray(raw)) return []
  return raw.filter((ref): ref is string => typeof ref === 'string' && isPage(ref)).slice(-MAX_TRAIL)
}

/** The trail after going back one page. */
export const closePage = (trail: Trail): Trail => (trail.length ? trail.slice(0, -1) : trail)

/** The trail cut back to the pages before the first one that no longer exists (its tracks were removed or retagged). */
export function pruneTrail(trail: Trail, exists: (ref: string) => boolean): Trail {
  const gone = trail.findIndex((ref) => !exists(ref))
  return gone < 0 ? trail : trail.slice(0, gone)
}
