import { resolveQueue } from './queue'
import { describeAge, playsLabel } from './smart'
import { sortTracks } from './sort'
import type { SortKey, SortSpec } from './sort'
import type { Playlist, Track } from '../types'

/**
 * The tracks a list shows and plays, in order: the library or a playlist, in the chosen sort. With the library order they
 * are the stored list itself, in the order they were stored. Smart lists order themselves and are not handled here, and
 * neither are album and artist pages, which open on top of a list instead of replacing it.
 *
 * A playlist that no longer exists shows the whole library for the moment before the view is reset.
 */
export function viewTracks(tracks: Track[], playlists: readonly Playlist[], viewId: string, sort: SortSpec): readonly Track[] {
  return sortTracks(resolveQueue(tracks, playlists, viewId), sort)
}

/** What a row needs to explain its place in a sorted list. */
export interface DetailSource {
  album: string
  trackNo: number
  year: number
  addedAt: number
  plays: number
}

/**
 * The extra words a row shows under the artist when the list is sorted by something that is not visible otherwise
 * (title, artist and length already are), or null.
 */
export function sortDetail(key: SortKey, t: DetailSource, now: number): string | null {
  switch (key) {
    case 'album':
      return t.album || null
    case 'track':
      return t.trackNo ? `track ${t.trackNo}` : null
    case 'year':
      return t.year ? String(t.year) : null
    case 'added': {
      const age = describeAge(t.addedAt, now)
      return age ? `added ${age}` : null
    }
    case 'plays':
      return t.plays ? playsLabel(t.plays) : null
    default:
      return null
  }
}
