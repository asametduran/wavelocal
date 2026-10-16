import { fold, matches, searchEntry } from './search'
import type { Query, Searchable } from './search'
import { directionWords, sortInAlbum } from './sort'
import type { SortDir, Sortable } from './sort'

/**
 * The library as albums and artists. An album is the tracks that share an album title and an owner (the album artist, or
 * for a compilation "Various Artists"); an artist is the tracks that share a performer. Names are compared the way
 * search compares them, so "İstanbul" and "ISTANBUL" are one album. Everything here is pure.
 */

/** What grouping needs of a track. */
export interface Groupable extends Sortable {
  id: string
  compilation: boolean
  coverBlob: Blob | null
}

export interface Album<T extends Groupable = Groupable> {
  /** Stable for a given library: album title and owner, folded. */
  id: string
  title: string
  /** Who the album belongs to: the album artist, "Various Artists" for a compilation, '' for the merged unknown album. */
  artist: string
  /** The year most of its tracks carry, or 0. */
  year: number
  /** In disc and track order. */
  tracks: T[]
  duration: number
  /** When its newest track was added. */
  addedAt: number
  /** The first track (in album order) that has artwork. */
  cover: T | null
  compilation: boolean
  /** Tracks that have no album tag. */
  unknown: boolean
}

export interface Artist<T extends Groupable = Groupable> {
  id: string
  name: string
  /** In album order. */
  tracks: T[]
  /** The albums the artist appears on (compilations included, whole), oldest first. */
  albums: Album<T>[]
  duration: number
  cover: T | null
}

export const VARIOUS_ARTISTS = 'Various Artists'
export const UNKNOWN_ALBUM = 'Unknown album'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** An album title that several different artists share most evenly is a compilation, whatever the tags say. */
function looksLikeCompilation<T extends Groupable>(bucket: readonly T[]): boolean {
  if (bucket.some((t) => t.albumArtist)) return false // the tags already say who the album belongs to
  if (bucket.some((t) => t.compilation)) return true
  if (bucket.length < 4) return false
  const counts = new Map<string, number>()
  for (const t of bucket) counts.set(fold(t.artist), (counts.get(fold(t.artist)) ?? 0) + 1)
  return counts.size >= 3 && Math.max(...counts.values()) * 2 <= bucket.length
}

interface Draft<T> {
  title: string
  owner: string
  tracks: T[]
  compilation: boolean
  unknown: boolean
}

function finish<T extends Groupable>(id: string, d: Draft<T>): Album<T> {
  const tracks = sortInAlbum(d.tracks)
  const years = new Map<number, number>()
  let duration = 0
  let addedAt = 0
  for (const t of tracks) {
    duration += t.duration
    addedAt = Math.max(addedAt, t.addedAt)
    if (t.year) years.set(t.year, (years.get(t.year) ?? 0) + 1)
  }
  let year = 0
  let best = 0
  for (const [y, count] of years) {
    if (count > best || (count === best && y < year)) {
      best = count
      year = y
    }
  }
  return { id, title: d.title, artist: d.owner, year, tracks, duration, addedAt, cover: tracks.find((t) => t.coverBlob) ?? null, compilation: d.compilation, unknown: d.unknown }
}

export type AlbumSortKey = 'artist' | 'title' | 'year' | 'added'

export interface AlbumSortSpec {
  key: AlbumSortKey
  dir: SortDir
}

/** The sort menu of the Albums view: each key with its label and the direction people usually want first. */
export const ALBUM_SORTS: readonly { key: AlbumSortKey; label: string; dir: SortDir }[] = [
  { key: 'artist', label: 'Artist', dir: 'asc' },
  { key: 'title', label: 'Album', dir: 'asc' },
  { key: 'year', label: 'Year', dir: 'asc' },
  { key: 'added', label: 'Date added', dir: 'desc' },
]

/** "Artist, A to Z" or "Date added, newest first": the album sort in a few words. */
export function describeAlbumSort(spec: AlbumSortSpec): string {
  const label = ALBUM_SORTS.find((s) => s.key === spec.key)?.label ?? spec.key
  return `${label}, ${directionWords(spec.key, spec.dir)}`
}

/** A stored album sort, repaired: anything unusable is by artist. */
export function parseAlbumSort(raw: unknown): AlbumSortSpec {
  const fallback: AlbumSortSpec = { key: 'artist', dir: 'asc' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback
  const r = raw as Record<string, unknown>
  const entry = ALBUM_SORTS.find((s) => s.key === r.key)
  if (!entry) return fallback
  return { key: entry.key, dir: r.dir === 'asc' || r.dir === 'desc' ? r.dir : entry.dir }
}

/** Albums by artist, then year (none last), then title. */
export function sortAlbums<T extends Groupable>(albums: readonly Album<T>[], key: AlbumSortKey, dir: SortDir = 'asc'): Album<T>[] {
  const s = dir === 'desc' ? -1 : 1
  const text = (x: string, y: string): number => (x && y ? collator.compare(x, y) : x ? -1 : y ? 1 : 0)
  const known = (x: number, y: number): number => (x && y ? x - y : x ? -1 : y ? 1 : 0)
  const byYear = (a: Album<T>, b: Album<T>): number => known(a.year, b.year)
  const byArtist = (a: Album<T>, b: Album<T>): number => text(a.artist, b.artist)
  const byTitle = (a: Album<T>, b: Album<T>): number => text(a.title, b.title)
  return albums
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      // an album with no title tag always goes last
      if (x.a.unknown !== y.a.unknown) return x.a.unknown ? 1 : -1
      let c = 0
      if (key === 'title') c = s * byTitle(x.a, y.a) || byArtist(x.a, y.a)
      else if (key === 'artist') c = s * byArtist(x.a, y.a) || byYear(x.a, y.a) || byTitle(x.a, y.a)
      else if (key === 'year') c = (x.a.year && y.a.year ? s * (x.a.year - y.a.year) : known(x.a.year, y.a.year)) || byArtist(x.a, y.a) || byTitle(x.a, y.a)
      else c = (x.a.addedAt && y.a.addedAt ? s * (x.a.addedAt - y.a.addedAt) : known(x.a.addedAt, y.a.addedAt)) || byArtist(x.a, y.a) || byTitle(x.a, y.a)
      return c || x.i - y.i
    })
    .map((x) => x.a)
}

/**
 * Group tracks into albums. Tracks with no album tag gather in an "Unknown album" for each artist, or, with
 * `mergeUnknown`, in a single one for everybody. Listed by artist, year, title.
 */
export function groupAlbums<T extends Groupable>(tracks: readonly T[], { mergeUnknown = false }: { mergeUnknown?: boolean } = {}): Album<T>[] {
  const buckets = new Map<string, T[]>()
  for (const t of tracks) {
    const key = fold(t.album)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(t)
    else buckets.set(key, [t])
  }

  const drafts = new Map<string, Draft<T>>()
  for (const [albumKey, bucket] of buckets) {
    const unknown = albumKey === ''
    const compilation = !unknown && (looksLikeCompilation(bucket) || bucket.some((t) => t.compilation))
    for (const t of bucket) {
      // the album artist when the tags give one, otherwise "Various Artists" for a compilation or the performer
      const owner = mergeUnknown && unknown ? '' : t.albumArtist || (compilation ? VARIOUS_ARTISTS : t.artist)
      const key = `${albumKey}|${fold(owner)}`
      const draft = drafts.get(key)
      if (draft) draft.tracks.push(t)
      else drafts.set(key, { title: unknown ? UNKNOWN_ALBUM : t.album.trim(), owner, tracks: [t], compilation, unknown })
    }
  }
  return sortAlbums(
    [...drafts].map(([id, d]) => finish(id, d)),
    'artist',
  )
}

/** Group tracks by performer, with the albums they appear on. Listed alphabetically. */
export function groupArtists<T extends Groupable>(tracks: readonly T[], albums: readonly Album<T>[] = groupAlbums(tracks)): Artist<T>[] {
  const albumOf = new Map<string, Album<T>>()
  for (const album of albums) for (const t of album.tracks) albumOf.set(t.id, album)

  const by = new Map<string, { name: string; tracks: T[] }>()
  for (const t of tracks) {
    const key = fold(t.artist) || 'unknown'
    const entry = by.get(key)
    if (entry) entry.tracks.push(t)
    else by.set(key, { name: t.artist.trim() || 'Unknown Artist', tracks: [t] })
  }

  const artists: Artist<T>[] = []
  for (const [id, entry] of by) {
    const seen = new Set<string>()
    const appears: Album<T>[] = []
    for (const t of entry.tracks) {
      const album = albumOf.get(t.id)
      if (album && !seen.has(album.id)) {
        seen.add(album.id)
        appears.push(album)
      }
    }
    // an artist's tracks follow their albums, oldest first (the order the albums are listed in), each album in its own
    // disc and track order: playing an artist walks the discography the way their page shows it
    const albumList = sortAlbums(appears, 'year')
    const own = new Set(entry.tracks.map((t) => t.id))
    const trackList = albumList.flatMap((album) => album.tracks.filter((t) => own.has(t.id)))
    artists.push({
      id,
      name: entry.name,
      tracks: trackList,
      albums: albumList,
      duration: trackList.reduce((sum, t) => sum + t.duration, 0),
      cover: trackList.find((t) => t.coverBlob) ?? null,
    })
  }
  return artists.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))
}

// ---- the shared index ------------------------------------------------------------------------------------------

export interface Groups<T extends Groupable = Groupable> {
  /** The cards of the Albums view: every album, with all tracks that have no album tag as one "Unknown album". */
  albums: Album<T>[]
  artists: Artist<T>[]
  /** Every album that can be opened by id, including each artist's own "Unknown album". */
  albumById: Map<string, Album<T>>
  artistById: Map<string, Artist<T>>
  /** The card of the Albums view each track (by id) belongs to; tracks with no album tag are on the merged "Unknown album". */
  albumOfTrack: Map<string, string>
  /** The artist each track (by id) belongs to. */
  artistOfTrack: Map<string, string>
}

// Keyed by the library array itself: a changed library is a new array, so it is grouped afresh and the old index collected.
const cache = new WeakMap<readonly object[], unknown>()

/** The albums and artists of a library: built once per library array, however many parts of the app ask. */
export function getGroups<T extends Groupable>(tracks: readonly T[]): Groups<T> {
  const cached = cache.get(tracks) as Groups<T> | undefined
  if (cached) return cached
  const all = groupAlbums(tracks)
  const artists = groupArtists(tracks, all)
  const albumById = new Map(all.map((a) => [a.id, a]))
  const unknown = all.filter((a) => a.unknown)
  const known = all.filter((a) => !a.unknown)
  let cards = known
  if (unknown.length) {
    const merged = groupAlbums(
      unknown.flatMap((a) => a.tracks),
      { mergeUnknown: true },
    )[0]
    if (merged) {
      albumById.set(merged.id, merged)
      cards = [...known, merged]
    }
  }
  const albumOfTrack = new Map<string, string>()
  for (const album of cards) for (const t of album.tracks) albumOfTrack.set(t.id, album.id)
  const artistOfTrack = new Map<string, string>()
  for (const artist of artists) for (const t of artist.tracks) artistOfTrack.set(t.id, artist.id)
  const groups: Groups<T> = { albums: cards, artists, albumById, artistById: new Map(artists.map((a) => [a.id, a])), albumOfTrack, artistOfTrack }
  cache.set(tracks, groups)
  return groups
}

export type GroupRef<T extends Groupable = Groupable> = { kind: 'album'; album: Album<T> } | { kind: 'artist'; artist: Artist<T> }

/** The album or artist a page ref (`album:<id>`, `artist:<id>`) names, or null when it is neither (or no longer exists). */
export function groupOf<T extends Groupable>(groups: Groups<T>, ref: string): GroupRef<T> | null {
  if (ref.startsWith('album:')) {
    const album = groups.albumById.get(ref.slice(6))
    return album ? { kind: 'album', album } : null
  }
  if (ref.startsWith('artist:')) {
    const artist = groups.artistById.get(ref.slice(7))
    return artist ? { kind: 'artist', artist } : null
  }
  return null
}

/** The albums or artists with at least one track that matches the search (shown whole, not cut down to the matches). */
export function filterGroups<G extends { tracks: readonly Searchable[] }>(groups: readonly G[], query: Query): readonly G[] {
  return query.empty ? groups : groups.filter((g) => g.tracks.some((t) => matches(query, searchEntry(t))))
}
