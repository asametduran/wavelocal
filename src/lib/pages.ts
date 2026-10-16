import { countLabel, dotted, listSummary } from './format'
import type { Album, Artist, Groupable } from './groups'
import { matches, searchEntry } from './search'
import type { Query, Searchable } from './search'

/**
 * What an album page and an artist page list: the tracks in play order, with headings that set them apart (a disc of a
 * multi-disc album, an album on an artist's page), plus the short lines the page header and the album cards show.
 * Pure, so the order and the wording are tested without a browser.
 */

/** One row of a page: a track, or a heading for the tracks after it. */
export type PageRow<T> =
  | {
      kind: 'track'
      t: T
      /** Its position among all the tracks of the page, so a track keeps its number while a search hides its neighbours. */
      index: number
    }
  | {
      kind: 'heading'
      /** Unique within the page. */
      key: string
      label: string
      /** A few words under the label ("1965 · 12 tracks"), or ''. */
      detail: string
      /** A track whose artwork stands for the heading, or null. */
      art: T | null
      /** The page that opens when the heading is chosen (`album:…`), or null for a plain heading. */
      open: string | null
      /** What the heading's play button starts; empty when the heading has none. */
      tracks: T[]
    }

type Item = Groupable & Searchable

const shown =
  (query: Query | undefined) =>
  (t: Searchable): boolean =>
    !query || query.empty || matches(query, searchEntry(t))

const yearText = (year: number): string => (year ? String(year) : '')

/**
 * The rows of an album page. A multi-disc album gets a "Disc 2" heading before each disc; a track with no disc number is
 * on disc 1. With a search only the matching tracks are listed, and a disc with none left on it has no heading.
 */
export function albumRows<T extends Item>(album: Album<T>, query?: Query): PageRow<T>[] {
  const show = shown(query)
  const discs = new Set(album.tracks.map((t) => t.discNo || 1))
  const rows: PageRow<T>[] = []
  let disc = 0
  album.tracks.forEach((t, index) => {
    if (!show(t)) return
    const d = t.discNo || 1
    if (discs.size > 1 && d !== disc) {
      disc = d
      rows.push({ kind: 'heading', key: `disc:${d}`, label: `Disc ${d}`, detail: '', art: null, open: null, tracks: [] })
    }
    rows.push({ kind: 'track', t, index })
  })
  return rows
}

/**
 * The rows of an artist page: for each album the artist appears on (oldest first, the order playing the artist walks
 * them in) a heading that opens the album, then the artist's own tracks on it. A compilation lists only their tracks,
 * though its heading opens the whole album. With a search, albums with no matching track are left out.
 */
export function artistRows<T extends Item>(artist: Artist<T>, query?: Query): PageRow<T>[] {
  const show = shown(query)
  const own = new Set(artist.tracks.map((t) => t.id))
  const rows: PageRow<T>[] = []
  let index = 0
  for (const album of artist.albums) {
    const mine = album.tracks.filter((t) => own.has(t.id))
    const first = index
    index += mine.length
    const found = mine.flatMap((t, i): PageRow<T>[] => (show(t) ? [{ kind: 'track', t, index: first + i }] : []))
    if (!found.length) continue
    rows.push({ kind: 'heading', key: `album:${album.id}`, label: album.title, detail: dotted(yearText(album.year), countLabel(mine.length, 'track')), art: album.cover, open: `album:${album.id}`, tracks: mine })
    rows.push(...found)
  }
  return rows
}

/** "1965 · 14 tracks · 31 min": the line under an album page's title. */
export const albumMeta = (album: Album): string => dotted(yearText(album.year), listSummary(album.tracks))

/** "3 albums · 27 tracks · 1 h 54 min": the line under an artist page's name. "Unknown album" does not count as an album. */
export function artistMeta(artist: Artist): string {
  const albums = artist.albums.filter((a) => !a.unknown).length
  return dotted(albums ? countLabel(albums, 'album') : '', listSummary(artist.tracks))
}

/** "3 albums · 27 tracks": the short line under an artist in a list, which does not add up the lengths of every track. */
export function artistLine(artist: Artist): string {
  const albums = artist.albums.filter((a) => !a.unknown).length
  return dotted(albums ? countLabel(albums, 'album') : '', countLabel(artist.tracks.length, 'track'))
}

/** The line under an album card's title: who made it and when; the merged "Unknown album" says how many tracks it holds. */
export const cardSubtitle = (album: Album): string => (album.unknown ? countLabel(album.tracks.length, 'track') : dotted(album.artist, yearText(album.year)))
