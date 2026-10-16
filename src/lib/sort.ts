/**
 * Ordering the library. Text sorts the way the reader's language sorts it (accents and case do not matter, "Track 2"
 * comes before "Track 10"), unknown values (no album, no year, length 0) are always last, ties fall back to a natural
 * secondary order (an artist's albums stay together, an album stays in disc and track order) and finally to library
 * position, so the result is stable. The direction applies to the primary key only.
 */

export interface Sortable {
  title: string
  artist: string
  album: string
  albumArtist: string
  trackNo: number
  discNo: number
  year: number
  duration: number
  addedAt: number
  plays: number
  lastPlayedAt: number | null
}

export type SortKey = 'library' | 'title' | 'artist' | 'album' | 'track' | 'duration' | 'added' | 'plays' | 'year'
export type SortDir = 'asc' | 'desc'

export interface SortSpec {
  key: SortKey
  dir: SortDir
}

/** The sort menu: each key with its label and the direction people usually want first. */
export const SORT_KEYS: readonly { key: SortKey; label: string; dir: SortDir }[] = [
  { key: 'library', label: 'Library order', dir: 'asc' },
  { key: 'title', label: 'Title', dir: 'asc' },
  { key: 'artist', label: 'Artist', dir: 'asc' },
  { key: 'album', label: 'Album', dir: 'asc' },
  { key: 'track', label: 'Track number', dir: 'asc' },
  { key: 'duration', label: 'Length', dir: 'asc' },
  { key: 'added', label: 'Date added', dir: 'desc' },
  { key: 'plays', label: 'Play count', dir: 'desc' },
  { key: 'year', label: 'Year', dir: 'asc' },
]

/** What each direction of a key means in words. The library order has no direction. */
const WORDS: Record<SortKey, readonly [asc: string, desc: string]> = {
  library: ['', ''],
  title: ['A to Z', 'Z to A'],
  artist: ['A to Z', 'Z to A'],
  album: ['A to Z', 'Z to A'],
  track: ['low to high', 'high to low'],
  duration: ['shortest first', 'longest first'],
  added: ['oldest first', 'newest first'],
  plays: ['fewest first', 'most first'],
  year: ['oldest first', 'newest first'],
}

/** "A to Z", "newest first": what ascending or descending means for this key, for labels and screen readers. */
export const directionWords = (key: SortKey, dir: SortDir): string => WORDS[key][dir === 'asc' ? 0 : 1]

/** "Title, A to Z" or, for the stored order, `manual` ("Library order", "Playlist order"). */
export function describeSort(spec: SortSpec, manual = 'Library order'): string {
  if (spec.key === 'library') return manual
  const label = SORT_KEYS.find((k) => k.key === spec.key)?.label ?? spec.key
  return `${label}, ${directionWords(spec.key, spec.dir)}`
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

type Compare = (a: Sortable, b: Sortable) => number
type Sign = 1 | -1

/** Text, empty last whatever the direction. */
const text =
  (get: (t: Sortable) => string, sign: Sign): Compare =>
  (a, b) => {
    const x = get(a)
    const y = get(b)
    return x && y ? sign * collator.compare(x, y) : x ? -1 : y ? 1 : 0
  }

/** A number where 0 means "unknown" and goes last whatever the direction. */
const known =
  (get: (t: Sortable) => number, sign: Sign): Compare =>
  (a, b) => {
    const x = get(a)
    const y = get(b)
    return x && y ? sign * (x - y) : x ? -1 : y ? 1 : 0
  }

/** A number where 0 is a real value (a play count). */
const plain =
  (get: (t: Sortable) => number, sign: Sign): Compare =>
  (a, b) =>
    sign * (get(a) - get(b))

const title = (t: Sortable): string => t.title
const artist = (t: Sortable): string => t.artist
const album = (t: Sortable): string => t.album
/** Who an album belongs to: its album artist, so a compilation stays together. */
const owner = (t: Sortable): string => t.albumArtist || t.artist
/** A track with no disc tag is on disc 1. */
const disc = (t: Sortable): number => t.discNo || 1
const track = (t: Sortable): number => t.trackNo

/** Inside an album: disc, then track number (unnumbered last), then title. */
const inAlbum = (): Compare[] => [plain(disc, 1), known(track, 1), text(title, 1)]

/** The tracks of one album in the order they are meant to be played. A sorted copy. */
export function sortInAlbum<T extends Sortable>(tracks: readonly T[]): T[] {
  const compares = inAlbum()
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      for (const compare of compares) {
        const c = compare(a.t, b.t)
        if (c) return c
      }
      return a.i - b.i
    })
    .map((x) => x.t)
}

function chain(key: SortKey, s: Sign): Compare[] {
  switch (key) {
    case 'title':
      return [text(title, s), text(artist, 1)]
    case 'artist':
      return [text(artist, s), text(album, 1), ...inAlbum()]
    case 'album':
      return [text(album, s), text(owner, 1), ...inAlbum()]
    case 'track':
      return [known(track, s), text(album, 1), text(title, 1)]
    case 'duration':
      return [known((t) => t.duration, s), text(title, 1)]
    case 'added':
      return [known((t) => t.addedAt, s)]
    case 'plays':
      return [plain((t) => t.plays, s), plain((t) => t.lastPlayedAt ?? 0, s), text(title, 1)]
    case 'year':
      return [known((t) => t.year, s), text(album, 1), ...inAlbum()]
    case 'library':
      return []
  }
}

/** A sorted copy (the library order itself, untouched, for `library`). */
export function sortTracks<T extends Sortable>(tracks: readonly T[], spec: SortSpec): readonly T[] {
  if (spec.key === 'library') return tracks
  const sign: Sign = spec.dir === 'desc' ? -1 : 1
  const compares = chain(spec.key, sign)
  // equal times mean "added in the same import": newest first then means last position first
  const byPosition: Sign = spec.key === 'added' ? sign : 1
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      for (const compare of compares) {
        const c = compare(a.t, b.t)
        if (c) return c
      }
      return byPosition * (a.i - b.i)
    })
    .map((x) => x.t)
}

/** A stored sort choice, repaired: anything unusable is the library order. */
export function parseSortSpec(raw: unknown): SortSpec {
  const fallback: SortSpec = { key: 'library', dir: 'asc' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback
  const r = raw as Record<string, unknown>
  const entry = SORT_KEYS.find((k) => k.key === r.key)
  if (!entry) return fallback
  return { key: entry.key, dir: r.dir === 'asc' || r.dir === 'desc' ? r.dir : entry.dir }
}
