/**
 * Smart playlists: lists that fill themselves from what the library knows about each track (when it was added, how
 * often and when it was last played). They are views, never stored: nothing here is saved except the per-track
 * counters in the library itself, which stay on this device.
 */
import type { Track } from '../types'

export type SmartKind = 'recent' | 'top' | 'played' | 'never'

export interface SmartList {
  id: `smart:${SmartKind}`
  kind: SmartKind
  name: string
  /** One sentence for the empty state and the screen reader. */
  description: string
  empty: string
}

/** The lists the player offers, in display order. */
export const SMART_LISTS: readonly SmartList[] = [
  { id: 'smart:recent', kind: 'recent', name: 'Recently added', description: 'The newest additions to your library.', empty: 'Nothing here yet. Add some music and the newest tracks show up first.' },
  { id: 'smart:top', kind: 'top', name: 'Most played', description: 'Your favourites, by how often you listened.', empty: 'Nothing played yet. A track counts after you have heard half of it, or 30 seconds.' },
  { id: 'smart:played', kind: 'played', name: 'Recently played', description: 'What you listened to last.', empty: 'Nothing played yet. A track counts after you have heard half of it, or 30 seconds.' },
  { id: 'smart:never', kind: 'never', name: 'Never played', description: 'Tracks you have not listened to yet.', empty: 'You have played everything in your library.' },
]

/** The newest/most-played lists stop here; "never played" is not capped because it is a to-do list. */
export const SMART_LIMIT = 100

const BY_ID = new Map<string, SmartList>(SMART_LISTS.map((l) => [l.id, l]))

export const isSmartId = (id: string): boolean => BY_ID.has(id)
export const smartList = (id: string): SmartList | null => BY_ID.get(id) ?? null

interface Indexed {
  t: Track
  i: number
}

const plays = (t: Track): number => t.plays || 0

/**
 * The tracks of one smart list. Ties are broken by library position so the order is stable; a library imported
 * before dates were recorded (`addedAt` 0) is treated as being in import order, newest last.
 */
export function smartTracks(kind: SmartKind, tracks: readonly Track[]): Track[] {
  const items: Indexed[] = tracks.map((t, i) => ({ t, i }))
  const out = (list: Indexed[], limit = SMART_LIMIT) => list.slice(0, limit).map((x) => x.t)
  switch (kind) {
    case 'recent':
      return out(items.sort((a, b) => (b.t.addedAt || 0) - (a.t.addedAt || 0) || b.i - a.i))
    case 'top':
      return out(items.filter((x) => plays(x.t) > 0).sort((a, b) => plays(b.t) - plays(a.t) || (b.t.lastPlayedAt ?? 0) - (a.t.lastPlayedAt ?? 0) || a.i - b.i))
    case 'played':
      return out(items.filter((x) => x.t.lastPlayedAt != null).sort((a, b) => (b.t.lastPlayedAt ?? 0) - (a.t.lastPlayedAt ?? 0) || a.i - b.i))
    case 'never':
      return out(
        items.filter((x) => plays(x.t) === 0),
        Infinity,
      )
  }
}

/** How many tracks each list holds right now, for the menu. */
export function smartCounts(tracks: readonly Track[]): Record<SmartKind, number> {
  let played = 0
  let never = 0
  for (const t of tracks) {
    if (t.lastPlayedAt != null) played++
    if (plays(t) === 0) never++
  }
  const withPlays = tracks.reduce((n, t) => n + (plays(t) > 0 ? 1 : 0), 0)
  return {
    recent: Math.min(tracks.length, SMART_LIMIT),
    top: Math.min(withPlays, SMART_LIMIT),
    played: Math.min(played, SMART_LIMIT),
    never,
  }
}

const DAY = 86_400_000

/** "today", "yesterday", "3 days ago", "2 weeks ago", or a date, for a timestamp; null when it is unknown (0). */
export function describeAge(timestamp: number, now: number): string | null {
  if (!timestamp || timestamp > now + DAY) return null
  const days = Math.floor((now - timestamp) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "1 play" / "12 plays". */
export const playsLabel = (n: number): string => `${n} ${n === 1 ? 'play' : 'plays'}`

/** The extra text a row shows in a smart list, or null. */
export function smartDetail(kind: SmartKind, t: Track, now: number): string | null {
  if (kind === 'recent') {
    const age = describeAge(t.addedAt || 0, now)
    return age ? `added ${age}` : null
  }
  if (kind === 'top') return plays(t) ? playsLabel(plays(t)) : null
  if (kind === 'played') {
    const age = t.lastPlayedAt ? describeAge(t.lastPlayedAt, now) : null
    return age ? `played ${age}` : null
  }
  return null
}
