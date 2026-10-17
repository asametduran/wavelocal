import { fold } from './search'
import type { Playlist } from '../types'

/** Naming and restoring playlists: what a name may be, how copies are named, how a deleted playlist comes back. */

export const MAX_PLAYLIST_NAME = 120
const DEFAULT_NAME = 'New playlist'

/** A name as typed, made safe: control characters and runs of whitespace become one space, trimmed, capped; `fallback` when nothing is left. */
export function cleanName(raw: string, fallback: string = DEFAULT_NAME): string {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PLAYLIST_NAME)
    .trim()
  return text || fallback
}

/** Names compare the way search does: case and accents do not make two names different. */
const used = (existing: readonly string[]): Set<string> => new Set(existing.map((name) => fold(name).trim()))

/** `base`, or `base 2`, `base 3`... when a playlist already has that name. */
export function uniqueName(existing: readonly string[], base: string): string {
  const taken = used(existing)
  if (!taken.has(fold(base).trim())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(fold(candidate).trim())) return candidate
  }
}

/** The name of a copy: "Mix copy", then "Mix copy 2"... Copying a copy numbers it instead of stacking the word. */
export function copyName(existing: readonly string[], name: string): string {
  const root = name.replace(/ copy(?: \d+)?$/i, '')
  return uniqueName(existing, `${root} copy`)
}

/**
 * The playlists with a deleted one put back where it was (or at the nearest end), holding only the tracks the library
 * still has. When a playlist with that id exists again the list is returned unchanged.
 */
export function restorePlaylist(list: readonly Playlist[], snapshot: { playlist: Playlist; index: number }, known: (id: string) => boolean): readonly Playlist[] {
  if (list.some((p) => p.id === snapshot.playlist.id)) return list
  const at = Math.min(Math.max(Math.trunc(snapshot.index) || 0, 0), list.length)
  const playlist: Playlist = { ...snapshot.playlist, trackIds: snapshot.playlist.trackIds.filter(known) }
  return [...list.slice(0, at), playlist, ...list.slice(at)]
}
